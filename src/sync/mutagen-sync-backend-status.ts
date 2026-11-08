import type { DevboxSyncStatus } from './devbox-sync-backend'
import type { MutagenSyncBackendState } from './mutagen-sync-backend-state'
import { mapConflict } from './mutagen-sync-backend-conflict'
import { ensureTransport, refreshCurrent } from './mutagen-sync-backend-session'
import { observation, phaseFor, watchMode } from './mutagen-sync-backend-status-mapping'

export async function status(state: MutagenSyncBackendState): Promise<DevboxSyncStatus> {
  const transportCurrent = await ensureTransport(state, false)
  if (transportCurrent) {
    await refreshCurrent(state)
  }
  const current = state.rawSession
  const conflicts = current
    ? current.conflicts.map((conflict) => mapConflict(state.profileId, conflict))
    : []
  const mode = current ? watchMode(current) : 'None'
  const problemCount = current?.problems?.length ?? 0
  const lastError = current?.lastError ?? null
  const unhealthy = conflicts.length > 0 || problemCount > 0 || lastError !== null
  const phase =
    !transportCurrent || state.paused ? 'paused' : current ? phaseFor(current, mode) : state.phase
  return {
    session: state.session,
    phase,
    capability: 'two-way-safe',
    direction: null,
    watchMode: mode,
    observation: observation(state, unhealthy),
    conflictCount: conflicts.length,
    problemCount,
    lastError
  }
}
