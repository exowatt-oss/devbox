import { describe, expect, it, vi } from 'vitest'
import type {
  DevboxSyncBackend,
  DevboxSyncConflict,
  DevboxSyncCreateRequest,
  DevboxSyncSessionIdentity,
  DevboxSyncStatus
} from './devbox-sync-backend'
import { DevboxSyncSupervisor } from './devbox-sync-supervisor'

const request: DevboxSyncCreateRequest = {
  profileId: 'p1',
  sessionId: 's1',
  rootClassId: 'working',
  localRoot: '/local',
  remoteRoot: '/remote',
  mode: 'two-way-safe'
}
const session: DevboxSyncSessionIdentity = {
  profileId: 'p1',
  sessionId: 's1',
  rootClassId: 'working',
  backend: 'mutagen',
  name: 'working',
  labels: {
    'devbox-profile': 'p1',
    'devbox-session': 's1',
    'devbox-root-class': 'working',
    'devbox-backend': 'mutagen'
  }
}
const status = (overrides: Partial<DevboxSyncStatus> = {}): DevboxSyncStatus => ({
  session,
  phase: 'watching-native',
  capability: 'two-way-safe',
  direction: null,
  watchMode: 'Native',
  observation: {
    observedAt: 1,
    lagMs: 1,
    freshness: 'fresh',
    lastChangeAt: 1,
    lastSynchronizedAt: 1
  },
  conflictCount: 0,
  ...overrides,
  problemCount: overrides.problemCount ?? 0,
  lastError: overrides.lastError ?? null
})

class FakeBackend implements DevboxSyncBackend {
  readonly calls: string[] = []
  paused = false
  sessions: DevboxSyncSessionIdentity[]
  current: DevboxSyncStatus
  constructor(
    private readonly kind: 'mutagen' | 'rsync-fallback' = 'mutagen',
    sessions: readonly DevboxSyncSessionIdentity[] = [session]
  ) {
    this.sessions = [...sessions]
    this.current =
      kind === 'mutagen'
        ? status({ session: this.sessions[0] ?? null })
        : status({
            session: this.sessions[0] ?? null,
            capability: 'degraded-directional',
            direction: 'local-to-remote',
            watchMode: 'None'
          })
  }
  async create(): Promise<DevboxSyncSessionIdentity> {
    this.calls.push('create')
    return {
      ...session,
      backend: this.kind,
      labels: { ...session.labels, 'devbox-backend': this.kind }
    }
  }
  async pause(): Promise<void> {
    this.calls.push('pause')
    this.paused = true
    this.current = { ...this.current, phase: 'paused' }
  }
  async resume(): Promise<void> {
    this.calls.push('resume')
    this.paused = false
    this.current = { ...this.current, phase: 'watching-native' }
  }
  async flush(): Promise<void> {
    this.calls.push('flush')
  }
  async status(): Promise<DevboxSyncStatus> {
    this.calls.push('status')
    return this.current
  }
  async listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    this.calls.push('conflicts')
    return []
  }
  async createConflictBackup(): Promise<never> {
    throw new Error('unused')
  }
  async resolveConflict(): Promise<never> {
    throw new Error('unused')
  }
  async terminate(sessionId?: string): Promise<void> {
    const target = sessionId ?? this.current.session?.sessionId
    this.calls.push(`terminate:${target ?? 'none'}`)
    this.sessions = this.sessions.filter((candidate) => candidate.sessionId !== target)
    if (this.current.session?.sessionId === target) {
      this.current = { ...this.current, session: null, phase: 'unavailable' }
    }
  }
  async listSessions(): Promise<readonly DevboxSyncSessionIdentity[]> {
    this.calls.push('sessions')
    return [...this.sessions]
  }
}

const options = (factory: (backend: FakeBackend) => void = () => undefined) => {
  const backend = new FakeBackend()
  factory(backend)
  return {
    backend,
    options: {
      profileId: 'p1',
      requests: [request],
      backendFactory: () => backend,
      statusIntervalMs: 0
    }
  }
}

describe('DevboxSyncSupervisor', () => {
  it('serializes repeated starts and creates one session set', async () => {
    const backend = new FakeBackend()
    const factory = vi.fn(() => backend)
    const supervisor = new DevboxSyncSupervisor({ ...options().options, backendFactory: factory })
    await Promise.all([supervisor.start(), supervisor.start(), supervisor.start()])
    expect(factory).toHaveBeenCalledTimes(1)
    expect(backend.calls.filter((call) => call === 'create')).toHaveLength(1)
  })

  it('keeps separate backends for requests sharing a root class', async () => {
    const firstBackend = new FakeBackend()
    const secondBackend = new FakeBackend()
    const supervisor = new DevboxSyncSupervisor({
      profileId: 'p1',
      requests: [
        { ...request, sessionId: 'credentials-1', rootClassId: 'credentials' },
        { ...request, sessionId: 'credentials-2', rootClassId: 'credentials' }
      ],
      backendFactory: (input) => input.sessionId === 'credentials-1' ? firstBackend : secondBackend,
      statusIntervalMs: 0
    })

    const result = await supervisor.start()

    expect(result.sessions).toHaveLength(2)
    expect(firstBackend.calls).toContain('create')
    expect(secondBackend.calls).toContain('create')
  })

  it('exposes polling SLOs without tightening the polling interval', async () => {
    const backend = new FakeBackend()
    backend.current = status({ watchMode: 'Polling' })
    const supervisor = new DevboxSyncSupervisor({
      ...options().options,
      backendFactory: () => backend
    })
    const result = await supervisor.start()
    expect(result.watchMode).toBe('Polling')
    expect(result.sloTarget).toEqual({ label: 'polling', p95Ms: 12_000, p99Ms: null })
  })

  it('degrades the supervisor when a Mutagen session reports an error or conflicts', async () => {
    const backend = new FakeBackend()
    backend.current = status({
      lastError: 'beta scan error: remote error: exceeded allowed entry count',
      problemCount: 1,
      conflictCount: 2
    })
    const supervisor = new DevboxSyncSupervisor({ ...options().options, backendFactory: () => backend })
    const result = await supervisor.start()
    expect(result.state).toBe('degraded')
    expect(result.degradation).toBe('mutagen-error')
    expect(result.conflictCount).toBe(2)
    expect(result.sessions[0]).toMatchObject({ problemCount: 1, conflictCount: 2, lastError: expect.stringContaining('exceeded') })
  })

  it('falls back to explicitly labelled directional rsync', async () => {
    const fallback = new FakeBackend('rsync-fallback')
    let received: DevboxSyncCreateRequest | undefined
    const supervisor = new DevboxSyncSupervisor({
      profileId: 'p1',
      requests: [request],
      mutagenAvailable: false,
      rsyncBackendFactory: (input) => {
        received = input
        return fallback
      },
      statusIntervalMs: 0
    })
    const result = await supervisor.start()
    expect(received).toMatchObject({ mode: 'directional', direction: 'local-to-remote' })
    expect(result.capability).toBe('degraded-directional')
    expect(result.degradation).toBe('mutagen-unavailable')
    expect(result.sloTarget.label).toBe('directional-fallback')
    expect(result.sloTarget.p95Ms).toBeNull()
  })

  it('flushes, pauses, and proves app-owned sessions inactive on disable', async () => {
    const fixtureOptions = options()
    const { backend, options: supervisorOptions } = fixtureOptions
    const supervisor = new DevboxSyncSupervisor(supervisorOptions)
    await supervisor.start()
    await supervisor.shutdownForDisable()
    expect(backend.calls).toEqual(
      expect.arrayContaining(['flush', 'pause', 'sessions', 'terminate:s1', 'status'])
    )
    expect((await supervisor.status()).state).toBe('stopped')
  })

  it('terminates every owned session on disable without touching foreign sessions', async () => {
    const secondOwned: DevboxSyncSessionIdentity = {
      ...session,
      sessionId: 's2',
      rootClassId: 'cache',
      name: 'cache',
      labels: {
        ...session.labels,
        'devbox-session': 's2',
        'devbox-root-class': 'cache'
      }
    }
    const foreign: DevboxSyncSessionIdentity = {
      ...session,
      profileId: 'foreign-profile',
      sessionId: 'foreign-session',
      name: 'foreign',
      labels: {
        ...session.labels,
        'devbox-profile': 'foreign-profile',
        'devbox-session': 'foreign-session'
      }
    }
    const backend = new FakeBackend('mutagen', [session, secondOwned, foreign])
    const supervisor = new DevboxSyncSupervisor({ ...options().options, backendFactory: () => backend })

    await supervisor.start()
    await supervisor.shutdownForDisable()

    expect(backend.calls).toEqual(
      expect.arrayContaining(['terminate:s1', 'terminate:s2'])
    )
    expect(backend.calls).not.toContain('terminate:foreign-session')
    expect(backend.sessions).toEqual([foreign])
  })

  it('keeps pause-only stop paths from terminating sessions', async () => {
    const fixtureOptions = options()
    const { backend, options: supervisorOptions } = fixtureOptions
    const supervisor = new DevboxSyncSupervisor(supervisorOptions)

    await supervisor.start()
    await supervisor.pause()

    expect(backend.calls).toContain('pause')
    expect(backend.calls.some((call) => call.startsWith('terminate:'))).toBe(false)
    expect(backend.sessions).toEqual([session])
  })
})

describe('DevboxSyncSupervisor profile registry', () => {
  it('returns exactly one supervisor for a profile', () => {
    DevboxSyncSupervisor.releaseProfile('p-registry')
    const one = DevboxSyncSupervisor.forProfile({ ...options().options, profileId: 'p-registry' })
    const two = DevboxSyncSupervisor.forProfile({ ...options().options, profileId: 'p-registry' })
    expect(two).toBe(one)
    DevboxSyncSupervisor.releaseProfile('p-registry')
  })
})
