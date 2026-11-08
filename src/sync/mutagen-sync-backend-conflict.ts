import { createHash } from 'node:crypto'
import { createDevboxError } from '../shared/devbox-errors'
import {
  assertDevboxSyncConflictResolutionRequest,
  conflictMatchesExpectedHashes,
  isSafeDevboxSyncRelativePath,
  type DevboxSyncBackupHandle,
  type DevboxSyncConflict,
  type DevboxSyncConflictResolutionRequest,
  type DevboxSyncConflictResolutionResult,
  type DevboxSyncContentIdentity
} from './devbox-sync-backend'
import type { MutagenConflictRecord } from './mutagen-cli'
import type { MutagenSyncBackendState } from './mutagen-sync-backend-state'
import {
  ensureTransport,
  identityRejected,
  operationRejected,
  refreshCurrent,
  requireCurrent
} from './mutagen-sync-backend-session'

function contentIdentity(side: MutagenConflictRecord['alpha']): DevboxSyncContentIdentity {
  return {
    kind: side.kind,
    hash: side.hash,
    ...(side.mode === undefined ? {} : { mode: side.mode }),
    ...(side.size === undefined ? {} : { size: side.size })
  }
}

function conflictClass(conflict: MutagenConflictRecord): DevboxSyncConflict['class'] {
  if (conflict.alpha.kind === 'missing' || conflict.beta.kind === 'missing') {
    return 'delete-vs-modify'
  }
  if (conflict.alpha.kind !== conflict.beta.kind) {
    return 'type'
  }
  if (
    conflict.alpha.mode !== undefined &&
    conflict.beta.mode !== undefined &&
    conflict.alpha.mode !== conflict.beta.mode
  ) {
    return 'permission'
  }
  return 'content'
}

function conflictId(sessionId: string, path: string): string {
  return `mutagen-${createHash('sha256').update(`${sessionId}\0${path}`).digest('hex').slice(0, 24)}`
}

export function mapConflict(sessionId: string, raw: MutagenConflictRecord): DevboxSyncConflict {
  if (!isSafeDevboxSyncRelativePath(raw.path)) {
    throw operationRejected(sessionId, 'unsafe-conflict-path')
  }
  return {
    conflictId: conflictId(sessionId, raw.path),
    path: raw.path,
    local: contentIdentity(raw.alpha),
    remote: contentIdentity(raw.beta),
    class: conflictClass(raw)
  }
}

export async function listConflicts(
  state: MutagenSyncBackendState
): Promise<readonly DevboxSyncConflict[]> {
  await refreshCurrent(state)
  if (!state.rawSession) {
    return [...state.conflictStore.list()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  }
  return state.rawSession.conflicts
    .map((conflict) => mapConflict(state.profileId, conflict))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export async function createConflictBackup(
  state: MutagenSyncBackendState,
  conflictId: string
): Promise<DevboxSyncBackupHandle> {
  const conflicts = await listConflicts(state)
  const conflict = conflicts.find((candidate) => candidate.conflictId === conflictId)
  if (!conflict) {
    throw operationRejected(state.profileId, 'conflict-not-found')
  }
  try {
    return await state.backupStore.create(conflict)
  } catch {
    throw createBackupError(state)
  }
}

export async function resolveConflict(
  state: MutagenSyncBackendState,
  request: DevboxSyncConflictResolutionRequest
): Promise<DevboxSyncConflictResolutionResult> {
  assertDevboxSyncConflictResolutionRequest(request)
  if (!(await ensureTransport(state, false))) {
    throw identityRejected()
  }
  if (state.paused) {
    throw operationRejected(state.profileId, 'paused')
  }
  const current = await requireCurrent(state)
  const conflicts = current.conflicts.map((conflict) => mapConflict(state.profileId, conflict))
  const conflict = conflicts.find((candidate) => candidate.conflictId === request.conflictId)
  if (!conflict) {
    throw operationRejected(state.profileId, 'conflict-not-found')
  }
  if (!conflictMatchesExpectedHashes(conflict, request)) {
    throw operationRejected(state.profileId, 'expected-hashes-no-longer-match')
  }
  if (
    request.backupHandle.localHash !== request.expectedLocalHash ||
    request.backupHandle.remoteHash !== request.expectedRemoteHash
  ) {
    throw operationRejected(state.profileId, 'pre-resolution-backup-required')
  }
  let hasBackup = false
  try {
    hasBackup = await state.backupStore.has(request.backupHandle)
  } catch {
    throw createBackupError(state)
  }
  if (!hasBackup) {
    throw operationRejected(state.profileId, 'pre-resolution-backup-required')
  }
  if (!state.resolveConflictOperation) {
    throw operationRejected(state.profileId, 'explicit-mutagen-resolution-hook-required')
  }
  await state.cli.pause(current.identifier)
  try {
    await state.resolveConflictOperation({ session: current, conflict, winner: request.winner })
    // The session stays paused (Devbox never leaves one running); the next `db sync` carries the resolution.
    state.conflictStore.remove(conflict.conflictId)
    const resolvedAt = state.now()
    state.lastChangeAt = resolvedAt
    state.lastSynchronizedAt = resolvedAt
    state.paused = true
    state.phase = 'paused'
    return {
      conflictId: conflict.conflictId,
      winner: request.winner,
      backupHandle: request.backupHandle,
      resolvedAt
    }
  } catch (error) {
    state.paused = true
    state.phase = 'paused'
    throw error
  }
}

function createBackupError(state: MutagenSyncBackendState) {
  return createDevboxError('unknown', {
    retryable: true,
    context: { profileId: state.profileId }
  })
}
