import type {
  DevboxSyncBackupStore,
  DevboxSyncConflict,
  DevboxSyncConflictStore,
  DevboxSyncCreateRequest,
  DevboxSyncPhase,
  DevboxSyncSessionIdentity,
  DevboxSyncSessionStore
} from './devbox-sync-backend'
import type { MutagenCli, MutagenSessionRecord } from './mutagen-cli'

export type MutagenSessionClient = Pick<
  MutagenCli,
  'createSession' | 'listSessions' | 'pause' | 'resume' | 'flush' | 'terminate'
> & {
  daemonStop?: () => Promise<void>
}

export type MutagenTransportIdentity = {
  isCurrent(): boolean
}

export type MutagenConflictResolution = (input: {
  session: MutagenSessionRecord
  conflict: DevboxSyncConflict
  winner: 'local' | 'remote'
}) => Promise<void>

export type MutagenSyncBackendOptions = {
  profileId: string
  cli: MutagenSessionClient
  sessionStore: DevboxSyncSessionStore
  conflictStore: DevboxSyncConflictStore
  backupStore: DevboxSyncBackupStore
  transportIdentity?: MutagenTransportIdentity
  remoteEndpoint?: (request: DevboxSyncCreateRequest) => string
  resolveConflict?: MutagenConflictResolution
  maxSessions?: number
  now?: () => number
}

export type MutagenSyncBackendState = {
  profileId: string
  cli: MutagenSessionClient
  sessionStore: DevboxSyncSessionStore
  conflictStore: DevboxSyncConflictStore
  backupStore: DevboxSyncBackupStore
  transportIdentity: MutagenTransportIdentity | undefined
  remoteEndpoint: (request: DevboxSyncCreateRequest) => string
  resolveConflictOperation: MutagenConflictResolution | undefined
  maxSessions: number
  now: () => number
  request: DevboxSyncCreateRequest | null
  session: DevboxSyncSessionIdentity | null
  rawSession: MutagenSessionRecord | null
  paused: boolean
  phase: DevboxSyncPhase
  lastChangeAt: number | null
  lastSynchronizedAt: number | null
  previousSuccessfulCycles: number
}

const DEFAULT_MAX_SESSIONS = 8

export function createMutagenSyncBackendState(
  options: MutagenSyncBackendOptions
): MutagenSyncBackendState {
  return {
    profileId: options.profileId,
    cli: options.cli,
    sessionStore: options.sessionStore,
    conflictStore: options.conflictStore,
    backupStore: options.backupStore,
    transportIdentity: options.transportIdentity,
    remoteEndpoint: options.remoteEndpoint ?? ((request) => request.remoteRoot),
    resolveConflictOperation: options.resolveConflict,
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    now: options.now ?? Date.now,
    request: null,
    session: null,
    rawSession: null,
    paused: false,
    phase: 'unavailable',
    lastChangeAt: null,
    lastSynchronizedAt: null,
    previousSuccessfulCycles: 0
  }
}
