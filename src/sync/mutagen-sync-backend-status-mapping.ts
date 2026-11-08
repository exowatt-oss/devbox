import type {
  DevboxSyncFreshness,
  DevboxSyncLagObservation,
  DevboxSyncPhase,
  DevboxSyncWatchMode
} from './devbox-sync-backend'
import type { MutagenSessionRecord } from './mutagen-cli'
import type { MutagenSyncBackendState } from './mutagen-sync-backend-state'

export function watchMode(session: MutagenSessionRecord): DevboxSyncWatchMode {
  if (session.watch.mode === 'no-watch') {
    return 'None'
  }
  if (session.watch.mode === 'force-poll' || session.watch.native !== true) {
    return 'Polling'
  }
  return 'Native'
}

export function phaseFor(
  session: MutagenSessionRecord,
  mode: DevboxSyncWatchMode
): DevboxSyncPhase {
  if (session.paused) {
    return 'paused'
  }
  if (session.conflicts.length > 0) {
    return 'conflicted'
  }
  const status = session.status.toLowerCase()
  if (status.includes('connect')) {
    return 'connecting'
  }
  if (status.includes('stage')) {
    return 'staging'
  }
  if (status.includes('transfer') || status.includes('sync')) {
    return 'transferring'
  }
  return mode === 'Native' ? 'watching-native' : mode === 'Polling' ? 'watching-polling' : 'staging'
}

export function recordObservation(
  state: MutagenSyncBackendState,
  raw: MutagenSessionRecord,
  forced: boolean
): void {
  const now = state.now()
  if (
    forced ||
    raw.successfulCycles > state.previousSuccessfulCycles ||
    raw.lastSynchronizedAt !== null
  ) {
    state.lastSynchronizedAt = raw.lastSynchronizedAt ?? now
    state.lastChangeAt = raw.lastChangeAt ?? state.lastSynchronizedAt
  }
  state.previousSuccessfulCycles = raw.successfulCycles
}

export function observation(
  state: MutagenSyncBackendState,
  hasConflicts: boolean
): DevboxSyncLagObservation {
  const observedAt = state.now()
  const freshness: DevboxSyncFreshness =
    state.lastSynchronizedAt === null ? 'unknown' : hasConflicts || state.paused ? 'stale' : 'fresh'
  return {
    observedAt,
    lagMs:
      state.lastSynchronizedAt === null ? null : Math.max(0, observedAt - state.lastSynchronizedAt),
    freshness,
    lastChangeAt: state.lastChangeAt,
    lastSynchronizedAt: state.lastSynchronizedAt
  }
}
