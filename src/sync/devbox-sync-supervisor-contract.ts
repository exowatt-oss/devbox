import type { DevboxOperationJournal } from '../core/devbox-operation-journal'
import type {
  DevboxSyncBackend,
  DevboxSyncCreateRequest,
  DevboxSyncDirection,
  DevboxSyncStatus,
  DevboxSyncWatchMode
} from './devbox-sync-backend'

export type DevboxSyncSloTarget = {
  label: 'native-watch' | 'polling' | 'directional-fallback' | 'none'
  p95Ms: number | null
  p99Ms: number | null
}

export const DEVBOX_NATIVE_WATCH_SLO: DevboxSyncSloTarget = Object.freeze({
  label: 'native-watch',
  p95Ms: 5_000,
  p99Ms: 10_000
})

export const DEVBOX_POLLING_SLO: DevboxSyncSloTarget = Object.freeze({
  label: 'polling',
  p95Ms: 12_000,
  p99Ms: null
})

export type DevboxSyncSupervisorState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'paused'
  | 'stopping'

export type DevboxSyncSupervisorStatus = {
  profileId: string
  state: DevboxSyncSupervisorState
  sessions: readonly DevboxSyncStatus[]
  capability: 'two-way-safe' | 'degraded-directional' | 'unavailable'
  watchMode: DevboxSyncWatchMode
  sloTarget: DevboxSyncSloTarget
  conflictCount: number
  backpressure: { bulkConcurrency: 1; queuedOperations: number }
  degradation?: 'mutagen-unavailable' | 'mutagen-unapproved' | 'mutagen-error'
  observedAt: number
}

export type BackendFactory = (
  request: DevboxSyncCreateRequest
) => DevboxSyncBackend | Promise<DevboxSyncBackend>

type Toggle = boolean | (() => boolean | Promise<boolean>)

export type DevboxSyncSupervisorOptions = {
  profileId: string
  requests: readonly DevboxSyncCreateRequest[]
  journal?: DevboxOperationJournal
  backendFactory?: BackendFactory
  mutagenBackendFactory?: BackendFactory
  rsyncBackendFactory?: BackendFactory
  mutagenAvailable?: Toggle
  mutagenApproved?: Toggle
  fallbackDirection?: DevboxSyncDirection
  statusIntervalMs?: number
  statusEventThrottleMs?: number
  now?: () => number
  onStatus?: (status: DevboxSyncSupervisorStatus) => void | Promise<void>
  /** Best-effort cleanup of profile-owned remote Mutagen agents after session shutdown. */
  onDisableCleanup?: () => void | Promise<void>
}
