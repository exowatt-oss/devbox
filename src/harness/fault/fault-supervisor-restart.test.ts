import { describe, expect, it } from 'vitest'
import { createDevboxError } from '../../shared/devbox-errors'
import type {
  DevboxSyncBackend,
  DevboxSyncConflict,
  DevboxSyncCreateRequest,
  DevboxSyncSessionIdentity,
  DevboxSyncStatus
} from '../../sync/devbox-sync-backend'
import { DevboxSyncSupervisor } from '../../sync/devbox-sync-supervisor'

const request: DevboxSyncCreateRequest = {
  profileId: 'fault-profile',
  sessionId: 'fault-session',
  rootClassId: 'working',
  localRoot: '/tmp/fault-local',
  remoteRoot: '/tmp/fault-remote',
  mode: 'two-way-safe'
}

function session(): DevboxSyncSessionIdentity {
  return {
    profileId: request.profileId,
    sessionId: request.sessionId,
    rootClassId: request.rootClassId,
    backend: 'mutagen',
    name: 'fault-session',
    labels: {
      'devbox-profile': request.profileId,
      'devbox-session': request.sessionId,
      'devbox-root-class': request.rootClassId,
      'devbox-backend': 'mutagen'
    }
  }
}

class PersistentSyncBackend implements DevboxSyncBackend {
  readonly identity = session()
  daemonAlive = true
  failPauseAfterMutation = false
  createCalls = 0
  private paused = false

  async create(): Promise<DevboxSyncSessionIdentity> {
    this.createCalls += 1
    return this.identity
  }

  async pause(): Promise<void> {
    this.paused = true
    if (this.failPauseAfterMutation) {
      this.failPauseAfterMutation = false
      throw createDevboxError('unknown', { retryable: true, context: { phase: 'pause' } })
    }
  }

  async resume(): Promise<void> {
    this.paused = false
  }

  async flush(): Promise<void> {
    if (!this.daemonAlive) {
      throw createDevboxError('offline', { retryable: true })
    }
  }

  async status(): Promise<DevboxSyncStatus> {
    if (!this.daemonAlive) {
      return {
        session: this.identity,
        phase: 'halted',
        capability: 'degraded-directional',
        direction: null,
        watchMode: 'None',
        observation: {
          observedAt: 1,
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
    return {
      session: this.identity,
      phase: this.paused ? 'paused' : 'watching-native',
      capability: 'two-way-safe',
      direction: null,
      watchMode: 'Native',
      observation: {
        observedAt: 1,
        lagMs: 0,
        freshness: this.paused ? 'stale' : 'fresh',
        lastChangeAt: 1,
        lastSynchronizedAt: 1
      },
      conflictCount: 0,
      problemCount: 0,
      lastError: null
    }
  }

  async listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    return []
  }

  async createConflictBackup(): Promise<never> {
    throw new Error('unused')
  }

  async resolveConflict(): Promise<never> {
    throw new Error('unused')
  }

  async terminate(): Promise<void> {}

  async listSessions(): Promise<readonly DevboxSyncSessionIdentity[]> {
    return [this.identity]
  }
}

function supervisor(backend: PersistentSyncBackend): DevboxSyncSupervisor {
  return new DevboxSyncSupervisor({
    profileId: request.profileId,
    requests: [request],
    backendFactory: () => backend,
    statusIntervalMs: 0
  })
}

describe('Devbox fault harness: daemon death and app restart', () => {
  it('reports a dead sync daemon as halted/degraded and recovers after restart', async () => {
    const backend = new PersistentSyncBackend()
    const running = supervisor(backend)
    await expect(running.start()).resolves.toMatchObject({
      state: 'running',
      capability: 'two-way-safe'
    })

    backend.daemonAlive = false
    const daemonDead = await running.status()
    expect(daemonDead).toMatchObject({
      state: 'degraded',
      capability: 'degraded-directional',
      sessions: [{ phase: 'halted', observation: { freshness: 'unknown' } }]
    })

    backend.daemonAlive = true
    const restarted = supervisor(backend)
    await expect(restarted.start()).resolves.toMatchObject({
      state: 'running',
      sessions: [{ phase: 'watching-native', observation: { freshness: 'fresh' } }]
    })
    expect(backend.createCalls).toBe(2)
  })

  it('keeps a pause acknowledged by the daemon truthful across app kill', async () => {
    const backend = new PersistentSyncBackend()
    const first = supervisor(backend)
    await first.start()
    backend.failPauseAfterMutation = true

    await expect(first.pause()).rejects.toMatchObject({ code: 'unknown' })
    const restarted = supervisor(backend)
    await expect(restarted.start()).resolves.toMatchObject({
      state: 'paused',
      sessions: [{ phase: 'paused', observation: { freshness: 'stale' } }]
    })
  })
})
