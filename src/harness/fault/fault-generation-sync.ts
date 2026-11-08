import type { DevboxSyncBackend, DevboxSyncConflict } from '../../sync/devbox-sync-backend'
import { InjectedFault } from './fault-roots'

type SyncPoint = 'flush' | 'pause' | 'resume'

export class FaultingGenerationSync implements Pick<
  DevboxSyncBackend,
  'flush' | 'pause' | 'resume' | 'listConflicts'
> {
  readonly calls: string[] = []
  readonly conflicts: DevboxSyncConflict[] = []
  private readonly failures: Partial<Record<SyncPoint, Error>>
  private readonly failEveryResume: boolean

  constructor(
    options: {
      failures?: Partial<Record<SyncPoint, Error>>
      failEveryResume?: boolean
    } = {}
  ) {
    this.failures = options.failures ?? {}
    this.failEveryResume = options.failEveryResume ?? false
  }

  async flush(): Promise<void> {
    this.calls.push('flush')
    this.throwIfConfigured('flush')
  }

  async pause(): Promise<void> {
    this.calls.push('pause')
    this.throwIfConfigured('pause')
  }

  async resume(): Promise<void> {
    this.calls.push('resume')
    if (this.failEveryResume) {
      throw new InjectedFault('resume')
    }
    this.throwIfConfigured('resume')
  }

  async listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    this.calls.push('conflicts')
    return [...this.conflicts]
  }

  private throwIfConfigured(point: SyncPoint): void {
    const failure = this.failures[point]
    if (failure) {
      throw failure
    }
  }
}
