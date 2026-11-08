import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import {
  DEVBOX_SYNC_BACKEND_LABEL,
  DEVBOX_SYNC_PROFILE_LABEL,
  DEVBOX_SYNC_ROOT_CLASS_LABEL,
  DEVBOX_SYNC_SESSION_LABEL,
  isDevboxSyncSessionOwnedByProfile,
  type DevboxSyncCreateRequest,
  type DevboxSyncSessionIdentity
} from './devbox-sync-backend'
import type { MutagenCreateSessionOptions, MutagenSessionRecord } from './mutagen-cli'
import { pollingIntervalCompatibility } from './mutagen-sync-backend-compatibility'
import { isValidMutagenSyncCreateRequest } from './mutagen-sync-backend-validation'
import type { MutagenSyncBackendState } from './mutagen-sync-backend-state'
import { phaseFor, recordObservation, watchMode } from './mutagen-sync-backend-status-mapping'

export const operationRejected = (profileId: string, field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { profileId, field } })

export const identityRejected = (): DevboxError => createDevboxError('ssh_identity_mismatch')

function labelsFor(request: DevboxSyncCreateRequest): Readonly<Record<string, string>> {
  return Object.freeze({
    [DEVBOX_SYNC_PROFILE_LABEL]: request.profileId,
    [DEVBOX_SYNC_SESSION_LABEL]: request.sessionId,
    [DEVBOX_SYNC_ROOT_CLASS_LABEL]: request.rootClassId,
    [DEVBOX_SYNC_BACKEND_LABEL]: 'mutagen'
  })
}

function isOwnedRaw(session: MutagenSessionRecord, profileId: string): boolean {
  return (
    session.labels[DEVBOX_SYNC_PROFILE_LABEL] === profileId &&
    session.labels[DEVBOX_SYNC_BACKEND_LABEL] === 'mutagen' &&
    typeof session.labels[DEVBOX_SYNC_SESSION_LABEL] === 'string' &&
    session.labels[DEVBOX_SYNC_SESSION_LABEL].length > 0 &&
    typeof session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] === 'string' &&
    session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL].length > 0
  )
}

function toIdentity(session: MutagenSessionRecord, profileId: string): DevboxSyncSessionIdentity {
  const sessionId = session.labels[DEVBOX_SYNC_SESSION_LABEL]
  const rootClassId = session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL]
  return Object.freeze({
    profileId,
    sessionId,
    rootClassId,
    backend: 'mutagen',
    name: session.name ?? `devbox-${rootClassId}`,
    labels: Object.freeze({
      [DEVBOX_SYNC_PROFILE_LABEL]: profileId,
      [DEVBOX_SYNC_SESSION_LABEL]: sessionId,
      [DEVBOX_SYNC_ROOT_CLASS_LABEL]: rootClassId,
      [DEVBOX_SYNC_BACKEND_LABEL]: 'mutagen'
    })
  })
}

export async function create(
  state: MutagenSyncBackendState,
  request: DevboxSyncCreateRequest
): Promise<DevboxSyncSessionIdentity> {
  validateRequest(state, request)
  await ensureTransport(state, true)
  const owned = await listOwnedRaw(state)
  const sameSession = owned.filter(
    (candidate) => candidate.labels[DEVBOX_SYNC_SESSION_LABEL] === request.sessionId
  )
  if (sameSession.length > 1) {
    throw operationRejected(state.profileId, 'duplicate-session')
  }
  const existing = sameSession[0]
  if (existing && existing.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] !== request.rootClassId) {
    throw operationRejected(state.profileId, 'root-class-session-identity-mismatch')
  }
  if (existing) {
    const compatibility = pollingIntervalCompatibility(existing, request)
    if (compatibility) {
      throw operationRejected(state.profileId, compatibility)
    }
    adopt(state, request, existing)
    return state.session as DevboxSyncSessionIdentity
  }
  if (owned.length >= state.maxSessions) {
    throw operationRejected(state.profileId, 'profile-session-cap')
  }
  const createOptions: MutagenCreateSessionOptions = {
    remoteEndpoint: state.remoteEndpoint(request),
    name: `devbox-${request.rootClassId}-${request.sessionId}`,
    labels: labelsFor(request),
    maxEntryCount: request.maxEntryCount,
    pollingIntervalSeconds: request.watchPollingIntervalSeconds,
    excludes: request.excludes,
    exclusionPolicy: request.exclusionPolicy
  }
  const created = await state.cli.createSession(request, createOptions)
  if (!isOwnedRaw(created, state.profileId)) {
    throw operationRejected(state.profileId, 'created-session-labels')
  }
  adopt(state, request, created)
  return state.session as DevboxSyncSessionIdentity
}

export async function observe(
  state: MutagenSyncBackendState,
  request: DevboxSyncCreateRequest
): Promise<void> {
  validateRequest(state, request)
  await ensureTransport(state, false)
  const owned = await listOwnedRaw(state)
  const matching = owned.find(
    (candidate) =>
      candidate.labels[DEVBOX_SYNC_SESSION_LABEL] === request.sessionId &&
      candidate.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] === request.rootClassId &&
      pollingIntervalCompatibility(candidate, request) === null
  )
  if (matching) {
    adopt(state, request, matching)
    return
  }
  state.request = request
  state.session = null
  state.rawSession = null
  state.paused = false
  state.phase = 'unavailable'
}

export async function pause(state: MutagenSyncBackendState): Promise<void> {
  const current = await requireCurrent(state)
  await state.cli.pause(current.identifier)
  state.paused = true
  state.phase = 'paused'
}

/**
 * Devbox never leaves a Mutagen session running: "resume" and "flush" are both one sync
 * cycle (resume, flush, pause again). Only `db sync` and these one-shot cycles ever unpause.
 */
export async function resume(state: MutagenSyncBackendState): Promise<void> {
  await syncOnce(state)
}

export async function flush(state: MutagenSyncBackendState): Promise<void> {
  await syncOnce(state)
}

async function syncOnce(state: MutagenSyncBackendState): Promise<void> {
  if (!(await ensureTransport(state, false))) {
    throw identityRejected()
  }
  const current = await requireCurrent(state)
  try {
    await state.cli.resume(current.identifier)
    await state.cli.flush(current.identifier)
    recordObservation(state, current, true)
  } finally {
    await state.cli.pause(current.identifier)
    state.paused = true
    state.phase = 'paused'
  }
}

export async function terminate(state: MutagenSyncBackendState, sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    const owned = await listOwnedRaw(state)
    const target = owned.find(
      (candidate) => candidate.labels[DEVBOX_SYNC_SESSION_LABEL] === sessionId
    )
    if (!target) {
      throw operationRejected(state.profileId, 'foreign-or-missing-session')
    }
    const identity = toIdentity(target, state.profileId)
    if (!isDevboxSyncSessionOwnedByProfile(identity, state.profileId, 'mutagen')) {
      throw operationRejected(state.profileId, 'session-label-mismatch')
    }
    await state.cli.terminate(target.identifier)
    state.sessionStore.remove(identity)
    if (state.rawSession?.identifier !== target.identifier) {
      return
    }
    state.request = null
    state.session = null
    state.rawSession = null
    state.paused = false
    state.phase = 'unavailable'
    return
  }

  if (!state.session || !state.rawSession) {
    return
  }
  if (!isDevboxSyncSessionOwnedByProfile(state.session, state.profileId, 'mutagen')) {
    throw operationRejected(state.profileId, 'session-label-mismatch')
  }
  await state.cli.terminate(state.rawSession.identifier)
  state.sessionStore.remove(state.session)
  state.request = null
  state.session = null
  state.rawSession = null
  state.paused = false
  state.phase = 'unavailable'
}

export async function listSessions(
  state: MutagenSyncBackendState
): Promise<readonly DevboxSyncSessionIdentity[]> {
  const owned = await listOwnedRaw(state)
  const identities = owned.map((session) => toIdentity(session, state.profileId))
  for (const identity of identities) {
    state.sessionStore.upsert(identity)
  }
  return identities.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
}

export async function shutdownForDisable(state: MutagenSyncBackendState): Promise<void> {
  // This is deliberately a fresh label-selector query. The in-memory session
  // store is only a cache and cannot be the source of truth across CLI runs.
  const owned = await listOwnedRaw(state)
  for (const session of owned) {
    await state.cli.flush(session.identifier).catch(() => undefined)
  }
  for (const session of owned) {
    const identity = toIdentity(session, state.profileId)
    if (!isDevboxSyncSessionOwnedByProfile(identity, state.profileId, 'mutagen')) {
      throw operationRejected(state.profileId, 'session-label-mismatch')
    }
    await state.cli.terminate(session.identifier)
    state.sessionStore.remove(identity)
  }
  const remaining = await listOwnedRaw(state)
  if (remaining.length > 0) {
    throw operationRejected(state.profileId, 'active-session-on-disable')
  }
  // The daemon is shared by every profile on this machine: stopping it would halt
  // other profiles' sessions, so only stop it once it holds no session at all.
  if ((await state.cli.listSessions()).length === 0) {
    await state.cli.daemonStop?.()
  }
  state.request = null
  state.session = null
  state.rawSession = null
  state.paused = false
  state.phase = 'unavailable'
}

function validateRequest(state: MutagenSyncBackendState, request: DevboxSyncCreateRequest): void {
  if (!isValidMutagenSyncCreateRequest(state.profileId, request)) {
    throw operationRejected(state.profileId, 'mutagen-two-way-safe-request')
  }
}

async function listOwnedRaw(
  state: MutagenSyncBackendState
): Promise<readonly MutagenSessionRecord[]> {
  const sessions = await state.cli.listSessions()
  return sessions.filter((session) => isOwnedRaw(session, state.profileId))
}

export async function refreshCurrent(state: MutagenSyncBackendState): Promise<void> {
  const owned = await listOwnedRaw(state)
  if (state.request) {
    const matching = owned.find(
      (candidate) =>
        candidate.labels[DEVBOX_SYNC_SESSION_LABEL] === state.request?.sessionId &&
        candidate.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] === state.request?.rootClassId &&
        pollingIntervalCompatibility(candidate, state.request) === null
    )
    if (matching) {
      adopt(state, state.request, matching)
    } else if (state.session) {
      state.sessionStore.remove(state.session)
      state.session = null
      state.rawSession = null
    }
  }
}

function adopt(
  state: MutagenSyncBackendState,
  request: DevboxSyncCreateRequest,
  raw: MutagenSessionRecord
): void {
  state.request = Object.freeze({
    ...request,
    excludes: Object.freeze([...(request.excludes ?? [])])
  })
  state.rawSession = raw
  state.session = toIdentity(raw, state.profileId)
  state.sessionStore.upsert(state.session)
  state.paused = raw.paused
  state.phase = phaseFor(raw, watchMode(raw))
  recordObservation(state, raw, false)
}

export async function ensureTransport(
  state: MutagenSyncBackendState,
  throwOnMismatch: boolean
): Promise<boolean> {
  if (!state.transportIdentity || state.transportIdentity.isCurrent()) {
    return true
  }
  if (state.rawSession && !state.paused) {
    await state.cli.pause(state.rawSession.identifier).catch(() => undefined)
  }
  state.paused = true
  state.phase = 'paused'
  if (throwOnMismatch) {
    throw identityRejected()
  }
  return false
}

export async function requireCurrent(
  state: MutagenSyncBackendState
): Promise<MutagenSessionRecord> {
  await refreshCurrent(state)
  if (!state.rawSession || !state.session) {
    throw operationRejected(state.profileId, 'session-required')
  }
  return state.rawSession
}
