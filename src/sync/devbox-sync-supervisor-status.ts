import type { DevboxOperationStatus } from '../shared/devbox-types'
import type { DevboxSyncStatus, DevboxSyncWatchMode } from './devbox-sync-backend'
import {
  DEVBOX_NATIVE_WATCH_SLO,
  DEVBOX_POLLING_SLO,
  type DevboxSyncSloTarget,
  type DevboxSyncSupervisorStatus
} from './devbox-sync-supervisor-contract'

const EMPTY_SLO: DevboxSyncSloTarget = Object.freeze({
  label: 'none',
  p95Ms: null,
  p99Ms: null
})

export function emptyStatus(profileId: string, now: number): DevboxSyncSupervisorStatus {
  return {
    profileId,
    state: 'stopped',
    sessions: [],
    capability: 'unavailable',
    watchMode: 'None',
    sloTarget: EMPTY_SLO,
    conflictCount: 0,
    backpressure: { bulkConcurrency: 1, queuedOperations: 0 },
    observedAt: now
  }
}

export function haltedStatus(now: number): DevboxSyncStatus {
  return {
    session: null,
    phase: 'halted',
    capability: 'degraded-directional',
    direction: null,
    watchMode: 'None',
    observation: {
      observedAt: now,
      lagMs: null,
      freshness: 'unknown',
      lastChangeAt: null,
      lastSynchronizedAt: null
    },
    conflictCount: 0,
    problemCount: 0,
    lastError: null
  }
}

export function watchModeFor(sessions: readonly DevboxSyncStatus[]): DevboxSyncWatchMode {
  const polling = sessions.some((session) => session.watchMode === 'Polling')
  const native = sessions.some((session) => session.watchMode === 'Native')
  return polling ? 'Polling' : native ? 'Native' : 'None'
}

export function sloFor(degraded: boolean, watchMode: DevboxSyncWatchMode): DevboxSyncSloTarget {
  if (degraded) {
    return { label: 'directional-fallback', p95Ms: null, p99Ms: null }
  }
  if (watchMode === 'Native') {
    return DEVBOX_NATIVE_WATCH_SLO
  }
  if (watchMode === 'Polling') {
    return DEVBOX_POLLING_SLO
  }
  return EMPTY_SLO
}

export function operationStatus(): DevboxOperationStatus {
  return {
    execution: { side: 'remote', state: 'running' },
    authority: { side: 'remote', state: 'owner' },
    freshness: { state: 'unknown' },
    conflict: { state: 'none' },
    drift: { state: 'none' },
    connectivity: { state: 'online' },
    auth: { state: 'unknown' },
    disk: { state: 'unknown' }
  }
}
