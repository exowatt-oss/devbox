import { createDevboxError, type DevboxError } from '../shared/devbox-errors'

// Preserve the existing public import path while the policy lives in its own module.
export { DEVBOX_SYNC_EXCLUSIONS } from './devbox-sync-exclusions'

export type DevboxSyncPhase =
  | 'connecting'
  | 'watching-native'
  | 'watching-polling'
  | 'staging'
  | 'transferring'
  | 'paused'
  | 'conflicted'
  | 'halted'
  | 'unavailable'

/** Values intentionally remain presentation-friendly so the UI can say "Polling". */
export type DevboxSyncWatchMode = 'Native' | 'Polling' | 'None'
export type DevboxSyncFreshness = 'fresh' | 'stale' | 'unknown'
export type DevboxSyncCapability = 'two-way-safe' | 'degraded-directional'
export type DevboxSyncDirection = 'local-to-remote' | 'remote-to-local'
/** `one-way-replica` makes the remote an exact mirror of the local root (Mutagen only). */
export type DevboxSyncRequestedMode =
  | 'two-way-safe'
  | 'two-way-resolved'
  | 'one-way-replica'
  | 'directional'

export const DEVBOX_MUTAGEN_MODES: ReadonlySet<DevboxSyncRequestedMode> = new Set([
  'two-way-safe',
  'two-way-resolved',
  'one-way-replica'
])
export type DevboxSyncExclusionPolicy = 'default' | 'explicit-only'

export type DevboxSyncLagObservation = {
  observedAt: number
  lagMs: number | null
  freshness: DevboxSyncFreshness
  lastChangeAt: number | null
  lastSynchronizedAt: number | null
}

export const DEVBOX_SYNC_PROFILE_LABEL = 'devbox-profile' as const
export const DEVBOX_SYNC_SESSION_LABEL = 'devbox-session' as const
export const DEVBOX_SYNC_ROOT_CLASS_LABEL = 'devbox-root-class' as const
export const DEVBOX_SYNC_BACKEND_LABEL = 'devbox-backend' as const

export type DevboxSyncSessionLabels = Readonly<Record<string, string>>

export type DevboxSyncSessionIdentity = {
  profileId: string
  sessionId: string
  rootClassId: string
  backend: 'mutagen' | 'rsync-fallback'
  name: string
  labels: DevboxSyncSessionLabels
}

export type DevboxSyncCreateRequest = {
  profileId: string
  sessionId: string
  rootClassId: string
  localRoot: string
  remoteRoot: string
  mode: DevboxSyncRequestedMode
  direction?: DevboxSyncDirection
  exclusionPolicy?: DevboxSyncExclusionPolicy
  maxEntryCount?: number
  /** Optional Mutagen watch polling override; absent means the 10-second default. */
  watchPollingIntervalSeconds?: number
  excludes?: readonly string[]
}

export type DevboxSyncStatus = {
  session: DevboxSyncSessionIdentity | null
  phase: DevboxSyncPhase
  capability: DevboxSyncCapability
  direction: DevboxSyncDirection | null
  watchMode: DevboxSyncWatchMode
  observation: DevboxSyncLagObservation
  conflictCount: number
  problemCount: number
  lastError: string | null
}

export type DevboxSyncContentKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'
export type DevboxSyncContentIdentity = {
  kind: DevboxSyncContentKind
  hash: string | null
  mode?: number
  size?: number
}

export type DevboxSyncConflictClass = 'content' | 'type' | 'delete-vs-modify' | 'permission'
export type DevboxSyncConflict = {
  conflictId: string
  path: string
  local: DevboxSyncContentIdentity
  remote: DevboxSyncContentIdentity
  class: DevboxSyncConflictClass
}

export type DevboxSyncBackupHandle = {
  id: string
  conflictId: string
  localHash: string | null
  remoteHash: string | null
  createdAt: number
}

export type DevboxSyncConflictResolutionRequest = {
  conflictId: string
  expectedLocalHash: string | null
  expectedRemoteHash: string | null
  backupHandle: DevboxSyncBackupHandle
  winner: 'local' | 'remote'
}

export type DevboxSyncConflictResolutionResult = {
  conflictId: string
  winner: 'local' | 'remote'
  backupHandle: DevboxSyncBackupHandle
  resolvedAt: number
}

/** A backend must never use an unscoped session store. */
export type DevboxSyncSessionStore = {
  list(): readonly DevboxSyncSessionIdentity[]
  upsert(session: DevboxSyncSessionIdentity): void
  remove(session: DevboxSyncSessionIdentity): void
}

export type DevboxSyncConflictStore = {
  list(): readonly DevboxSyncConflict[]
  remove(conflictId: string): void
}

export type DevboxSyncBackupStore = {
  create(conflict: DevboxSyncConflict): Promise<DevboxSyncBackupHandle>
  has(handle: DevboxSyncBackupHandle): Promise<boolean>
}

/**
 * Process output is deliberately not part of the backend contract.  Adapters
 * map it to DevboxError before it crosses this boundary.
 */
export type DevboxSyncOperationError = DevboxError

/**
 * Backend-neutral contract.  Implementations throw only DevboxError-shaped
 * values produced by createDevboxError; callers never receive raw process or
 * filesystem errors from these methods.
 */
export type DevboxSyncBackend = {
  create(request: DevboxSyncCreateRequest): Promise<DevboxSyncSessionIdentity>
  pause(): Promise<void>
  resume(): Promise<void>
  flush(): Promise<void>
  status(): Promise<DevboxSyncStatus>
  listConflicts(): Promise<readonly DevboxSyncConflict[]>
  createConflictBackup(conflictId: string): Promise<DevboxSyncBackupHandle>
  resolveConflict(
    request: DevboxSyncConflictResolutionRequest
  ): Promise<DevboxSyncConflictResolutionResult>
  terminate(sessionId?: string): Promise<void>
  listSessions(): Promise<readonly DevboxSyncSessionIdentity[]>
  /** Observe persistent live state without creating a missing session. */
  observe?(request: DevboxSyncCreateRequest): Promise<DevboxSyncStatus>
  /** Enumerate and terminate all live sessions owned by this profile. */
  shutdownForDisable?(): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isHash = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const invalidResolution = (field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { field } })

/**
 * Validates the safety-critical portion of a resolution before an adapter can
 * touch either replica.  `undefined` is rejected intentionally: a caller must
 * make the current identity decision explicit, including for a missing side.
 */
export function validateDevboxSyncConflictResolutionRequest(input: unknown): DevboxError | null {
  if (!isRecord(input)) {
    return invalidResolution('conflict-resolution-request')
  }
  if (typeof input.conflictId !== 'string' || input.conflictId.length === 0) {
    return invalidResolution('conflict-id')
  }
  if (!isHash(input.expectedLocalHash) || !isHash(input.expectedRemoteHash)) {
    return invalidResolution('expected-hashes')
  }
  if (input.winner !== 'local' && input.winner !== 'remote') {
    return invalidResolution('winner')
  }
  if (!isRecord(input.backupHandle)) {
    return invalidResolution('backup-handle')
  }
  if (
    typeof input.backupHandle.id !== 'string' ||
    input.backupHandle.id.length === 0 ||
    input.backupHandle.conflictId !== input.conflictId ||
    !isHash(input.backupHandle.localHash) ||
    !isHash(input.backupHandle.remoteHash) ||
    typeof input.backupHandle.createdAt !== 'number' ||
    !Number.isSafeInteger(input.backupHandle.createdAt) ||
    input.backupHandle.createdAt < 0
  ) {
    return invalidResolution('backup-handle')
  }
  return null
}

export function assertDevboxSyncConflictResolutionRequest(
  input: unknown
): asserts input is DevboxSyncConflictResolutionRequest {
  const error = validateDevboxSyncConflictResolutionRequest(input)
  if (error) {
    throw error
  }
}

export function isDevboxSyncSessionOwnedByProfile(
  session: DevboxSyncSessionIdentity,
  profileId: string,
  backend: DevboxSyncSessionIdentity['backend']
): boolean {
  return (
    session.profileId === profileId &&
    session.backend === backend &&
    session.labels[DEVBOX_SYNC_PROFILE_LABEL] === profileId &&
    session.labels[DEVBOX_SYNC_SESSION_LABEL] === session.sessionId &&
    session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] === session.rootClassId &&
    session.labels[DEVBOX_SYNC_BACKEND_LABEL] === backend
  )
}

export function conflictMatchesExpectedHashes(
  conflict: DevboxSyncConflict,
  request: Pick<DevboxSyncConflictResolutionRequest, 'expectedLocalHash' | 'expectedRemoteHash'>
): boolean {
  return (
    conflict.local.hash === request.expectedLocalHash &&
    conflict.remote.hash === request.expectedRemoteHash
  )
}

export function isSafeDevboxSyncRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !path.split(/[\\/]/u).some((part) => part.length === 0 || part === '..')
  )
}
