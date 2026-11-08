import type {
  DevboxSyncBackupHandle,
  DevboxSyncBackend,
  DevboxSyncConflict,
  DevboxSyncConflictResolutionRequest,
  DevboxSyncConflictResolutionResult,
  DevboxSyncCreateRequest,
  DevboxSyncSessionIdentity,
  DevboxSyncStatus
} from './devbox-sync-backend'
import {
  create as createSession,
  flush,
  listSessions,
  observe,
  pause,
  resume,
  shutdownForDisable,
  terminate
} from './mutagen-sync-backend-session'
import {
  createConflictBackup,
  listConflicts,
  resolveConflict
} from './mutagen-sync-backend-conflict'
import { status } from './mutagen-sync-backend-status'
import {
  createMutagenSyncBackendState,
  type MutagenSyncBackendOptions,
  type MutagenSyncBackendState
} from './mutagen-sync-backend-state'

export class MutagenSyncBackend implements DevboxSyncBackend {
  private readonly state: MutagenSyncBackendState

  constructor(options: MutagenSyncBackendOptions) {
    this.state = createMutagenSyncBackendState(options)
  }

  async create(request: DevboxSyncCreateRequest): Promise<DevboxSyncSessionIdentity> {
    return createSession(this.state, request)
  }

  async observe(request: DevboxSyncCreateRequest): Promise<DevboxSyncStatus> {
    await observe(this.state, request)
    return status(this.state)
  }

  async shutdownForDisable(): Promise<void> {
    return shutdownForDisable(this.state)
  }

  async pause(): Promise<void> {
    return pause(this.state)
  }

  async resume(): Promise<void> {
    return resume(this.state)
  }

  async flush(): Promise<void> {
    return flush(this.state)
  }

  async status(): Promise<DevboxSyncStatus> {
    return status(this.state)
  }

  async listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    return listConflicts(this.state)
  }

  async createConflictBackup(conflictId: string): Promise<DevboxSyncBackupHandle> {
    return createConflictBackup(this.state, conflictId)
  }

  async resolveConflict(
    request: DevboxSyncConflictResolutionRequest
  ): Promise<DevboxSyncConflictResolutionResult> {
    return resolveConflict(this.state, request)
  }

  async terminate(sessionId?: string): Promise<void> {
    return terminate(this.state, sessionId)
  }

  async listSessions(): Promise<readonly DevboxSyncSessionIdentity[]> {
    return listSessions(this.state)
  }
}

export type {
  MutagenConflictResolution,
  MutagenSessionClient,
  MutagenSyncBackendOptions,
  MutagenTransportIdentity
} from './mutagen-sync-backend-state'
export type { DevboxSyncBackend, DevboxSyncCapability } from './devbox-sync-backend'
