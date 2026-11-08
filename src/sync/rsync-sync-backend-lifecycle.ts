import {
  assertDevboxSyncConflictResolutionRequest,
  conflictMatchesExpectedHashes,
  DEVBOX_SYNC_BACKEND_LABEL,
  DEVBOX_SYNC_PROFILE_LABEL,
  DEVBOX_SYNC_ROOT_CLASS_LABEL,
  DEVBOX_SYNC_SESSION_LABEL,
  isDevboxSyncSessionOwnedByProfile,
  isSafeDevboxSyncRelativePath,
  type DevboxSyncBackend,
  type DevboxSyncBackupHandle,
  type DevboxSyncBackupStore,
  type DevboxSyncConflict,
  type DevboxSyncConflictResolutionRequest,
  type DevboxSyncConflictResolutionResult,
  type DevboxSyncConflictStore,
  type DevboxSyncCreateRequest,
  type DevboxSyncLagObservation,
  type DevboxSyncSessionIdentity,
  type DevboxSyncSessionStore,
  type DevboxSyncStatus
} from './devbox-sync-backend'
import {
  buildRsyncSyncArguments,
  operationRejected,
  runnerFailed,
  validateCreateRequest
} from './rsync-sync-backend-safety'
import { syncFreshness } from './rsync-sync-backend-freshness'
import { runRsyncCommand } from './rsync-sync-backend-runner'

export type RsyncCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type RsyncCommandRunner = (
  command: 'rsync',
  args: readonly string[],
  options?: { signal?: AbortSignal }
) => Promise<RsyncCommandResult>

export type RsyncSyncBackendOptions = {
  profileId: string
  commandRunner: RsyncCommandRunner
  sessionStore: DevboxSyncSessionStore
  conflictStore: DevboxSyncConflictStore
  backupStore: DevboxSyncBackupStore
  now?: () => number
}

export class RsyncSyncBackend implements DevboxSyncBackend {
  private readonly profileId: string
  private readonly commandRunner: RsyncCommandRunner
  private readonly sessionStore: DevboxSyncSessionStore
  private readonly conflictStore: DevboxSyncConflictStore
  private readonly backupStore: DevboxSyncBackupStore
  private readonly now: () => number
  private request: DevboxSyncCreateRequest | null = null
  private session: DevboxSyncSessionIdentity | null = null
  private paused = false
  private phase: DevboxSyncStatus['phase'] = 'unavailable'
  private lastChangeAt: number | null = null
  private lastSynchronizedAt: number | null = null
  private lastAttemptFailed = false

  constructor(options: RsyncSyncBackendOptions) {
    this.profileId = options.profileId
    this.commandRunner = options.commandRunner
    this.sessionStore = options.sessionStore
    this.conflictStore = options.conflictStore
    this.backupStore = options.backupStore
    this.now = options.now ?? Date.now
  }

  async create(request: DevboxSyncCreateRequest): Promise<DevboxSyncSessionIdentity> {
    validateCreateRequest(request, this.profileId)
    if (this.session && this.request?.sessionId === request.sessionId) {
      return this.session
    }
    if (this.session) {
      throw operationRejected(this.profileId, 'session-already-created')
    }

    const existing = this.sessionStore
      .list()
      .find(
        (candidate) =>
          candidate.sessionId === request.sessionId &&
          isDevboxSyncSessionOwnedByProfile(candidate, this.profileId, 'rsync-fallback')
      )
    const session =
      existing ??
      Object.freeze({
        profileId: this.profileId,
        sessionId: request.sessionId,
        rootClassId: request.rootClassId,
        backend: 'rsync-fallback' as const,
        name: `devbox-${request.sessionId}`,
        labels: Object.freeze({
          [DEVBOX_SYNC_PROFILE_LABEL]: this.profileId,
          [DEVBOX_SYNC_SESSION_LABEL]: request.sessionId,
          [DEVBOX_SYNC_ROOT_CLASS_LABEL]: request.rootClassId,
          [DEVBOX_SYNC_BACKEND_LABEL]: 'rsync-fallback'
        })
      })

    this.request = Object.freeze({
      ...request,
      excludes: Object.freeze([...(request.excludes ?? [])])
    })
    this.session = session
    this.sessionStore.upsert(session)
    this.paused = false
    this.phase = 'staging'
    return session
  }

  async pause(): Promise<void> {
    this.requireSession()
    this.paused = true
    this.phase = 'paused'
  }

  async resume(): Promise<void> {
    this.requireSession()
    this.paused = false
    this.phase = this.conflictStore.list().length > 0 ? 'conflicted' : 'staging'
  }

  async flush(): Promise<void> {
    const request = this.requireRequest()
    if (this.paused) {
      throw operationRejected(this.profileId, 'paused')
    }
    this.phase = 'transferring'
    await this.runRsync(buildRsyncSyncArguments(request))
    const timestamp = this.now()
    this.lastChangeAt = timestamp
    this.lastSynchronizedAt = timestamp
    this.phase = this.conflictStore.list().length > 0 ? 'conflicted' : 'staging'
  }

  async status(): Promise<DevboxSyncStatus> {
    const conflicts = this.conflictStore.list()
    const observation: DevboxSyncLagObservation = {
      observedAt: this.now(),
      lagMs:
        this.lastSynchronizedAt === null ? null : Math.max(0, this.now() - this.lastSynchronizedAt),
      freshness: syncFreshness(this.lastSynchronizedAt, this.lastAttemptFailed, conflicts.length),
      lastChangeAt: this.lastChangeAt,
      lastSynchronizedAt: this.lastSynchronizedAt
    }
    return {
      session: this.session,
      phase: this.paused ? 'paused' : conflicts.length > 0 ? 'conflicted' : this.phase,
      capability: 'degraded-directional',
      direction: this.request?.direction ?? null,
      watchMode: 'None',
      observation,
      conflictCount: conflicts.length,
      problemCount: 0,
      lastError: null
    }
  }

  async listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    return [...this.conflictStore.list()].sort((left, right) => left.path.localeCompare(right.path))
  }

  async createConflictBackup(conflictId: string): Promise<DevboxSyncBackupHandle> {
    this.requireSession()
    const conflict = this.conflictStore
      .list()
      .find((candidate) => candidate.conflictId === conflictId)
    if (!conflict) {
      throw operationRejected(this.profileId, 'conflict-not-found')
    }
    try {
      return await this.backupStore.create(conflict)
    } catch {
      throw runnerFailed(this.profileId)
    }
  }

  async resolveConflict(
    request: DevboxSyncConflictResolutionRequest
  ): Promise<DevboxSyncConflictResolutionResult> {
    assertDevboxSyncConflictResolutionRequest(request)
    const syncRequest = this.requireRequest()
    if (this.paused) {
      throw operationRejected(this.profileId, 'paused')
    }
    const conflict = this.conflictStore
      .list()
      .find((candidate) => candidate.conflictId === request.conflictId)
    if (!conflict) {
      throw operationRejected(this.profileId, 'conflict-not-found')
    }
    if (!conflictMatchesExpectedHashes(conflict, request)) {
      throw operationRejected(this.profileId, 'expected-hashes-no-longer-match')
    }
    if (
      request.backupHandle.localHash !== request.expectedLocalHash ||
      request.backupHandle.remoteHash !== request.expectedRemoteHash
    ) {
      throw operationRejected(this.profileId, 'backup-handle-hashes')
    }
    let hasBackup = false
    try {
      hasBackup = await this.backupStore.has(request.backupHandle)
    } catch {
      throw runnerFailed(this.profileId)
    }
    if (!hasBackup) {
      throw operationRejected(this.profileId, 'pre-resolution-backup-required')
    }
    if (request.winner !== (syncRequest.direction === 'local-to-remote' ? 'local' : 'remote')) {
      throw operationRejected(this.profileId, 'directional-winner-mismatch')
    }
    if (!isSafeDevboxSyncRelativePath(conflict.path)) {
      throw operationRejected(this.profileId, 'conflict-path')
    }

    this.phase = 'transferring'
    await this.runRsync(buildRsyncSyncArguments(syncRequest, conflict.path))
    this.conflictStore.remove(conflict.conflictId)
    const resolvedAt = this.now()
    this.lastChangeAt = resolvedAt
    this.lastSynchronizedAt = resolvedAt
    this.phase = 'staging'
    return {
      conflictId: conflict.conflictId,
      winner: request.winner,
      backupHandle: request.backupHandle,
      resolvedAt
    }
  }

  async terminate(sessionId?: string): Promise<void> {
    const target = sessionId === undefined ? this.session : this.sessionStore.list().find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        isDevboxSyncSessionOwnedByProfile(candidate, this.profileId, 'rsync-fallback')
    )
    if (!target) {
      if (sessionId) {
        throw operationRejected(this.profileId, 'foreign-or-missing-session')
      }
      return
    }
    if (!isDevboxSyncSessionOwnedByProfile(target, this.profileId, 'rsync-fallback')) {
      throw operationRejected(this.profileId, 'session-label-mismatch')
    }
    this.sessionStore.remove(target)
    if (this.session?.sessionId !== target.sessionId) {
      return
    }
    this.request = null
    this.session = null
    this.paused = false
    this.phase = 'unavailable'
  }

  async listSessions(): Promise<readonly DevboxSyncSessionIdentity[]> {
    return this.sessionStore
      .list()
      .filter((candidate) =>
        isDevboxSyncSessionOwnedByProfile(candidate, this.profileId, 'rsync-fallback')
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private requireSession(): DevboxSyncSessionIdentity {
    if (!this.session) {
      throw operationRejected(this.profileId, 'session-required')
    }
    return this.session
  }

  private requireRequest(): DevboxSyncCreateRequest {
    this.requireSession()
    if (!this.request) {
      throw operationRejected(this.profileId, 'request-required')
    }
    return this.request
  }

  private async runRsync(args: readonly string[]): Promise<void> {
    try {
      await runRsyncCommand(this.commandRunner, this.profileId, args)
      this.lastAttemptFailed = false
    } catch (error) {
      this.phase = 'halted'
      this.lastAttemptFailed = true
      throw error
    }
  }
}
