import {
  createSupervisorRuntime,
  flush,
  listConflicts,
  pause,
  resume,
  shutdownForDisable,
  dispose,
  start,
  status,
  verify
} from './devbox-sync-supervisor-runtime'
import type { SupervisorRuntime } from './devbox-sync-supervisor-runtime'
import type { DevboxSyncConflict } from './devbox-sync-backend'
import type {
  DevboxSyncSupervisorOptions,
  DevboxSyncSupervisorStatus
} from './devbox-sync-supervisor-contract'

const registry = new Map<string, DevboxSyncSupervisor>()

export class DevboxSyncSupervisor {
  static forProfile(options: DevboxSyncSupervisorOptions): DevboxSyncSupervisor {
    const existing = registry.get(options.profileId)
    if (existing) {
      return existing
    }
    const supervisor = new DevboxSyncSupervisor(options)
    registry.set(options.profileId, supervisor)
    return supervisor
  }

  static releaseProfile(profileId: string): void {
    registry.delete(profileId)
  }

  private readonly runtime: SupervisorRuntime

  constructor(options: DevboxSyncSupervisorOptions) {
    this.runtime = createSupervisorRuntime(options)
  }

  start(): Promise<DevboxSyncSupervisorStatus> {
    return start(this.runtime)
  }

  status(): Promise<DevboxSyncSupervisorStatus> {
    return status(this.runtime)
  }

  pause(): Promise<void> {
    return pause(this.runtime)
  }

  resume(): Promise<void> {
    return resume(this.runtime)
  }

  flush(): Promise<void> {
    return flush(this.runtime)
  }

  verify(): Promise<DevboxSyncSupervisorStatus> {
    return verify(this.runtime)
  }

  listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    return listConflicts(this.runtime)
  }

  shutdownForDisable(): Promise<void> {
    return shutdownForDisable(this.runtime)
  }

  dispose(): Promise<void> {
    return dispose(this.runtime)
  }
}
