import { describe, expect, it, vi } from 'vitest'
import type {
  DevboxSyncBackupHandle,
  DevboxSyncBackupStore,
  DevboxSyncConflict,
  DevboxSyncConflictStore,
  DevboxSyncSessionIdentity,
  DevboxSyncSessionStore
} from './devbox-sync-backend'
import {
  MutagenSyncBackend,
  type MutagenSessionClient,
  type MutagenSyncBackendOptions
} from './mutagen-sync-backend'
import type {
  MutagenConflictRecord,
  MutagenCreateSessionOptions,
  MutagenSessionRecord
} from './mutagen-cli'

const request = {
  profileId: 'profile-1',
  sessionId: 'session-1',
  rootClassId: 'working',
  localRoot: '/local/project',
  remoteRoot: '/remote/project',
  mode: 'two-way-safe' as const,
  maxEntryCount: 234_567
}

const conflict: MutagenConflictRecord = {
  path: 'src/index.ts',
  alpha: { kind: 'file', hash: 'local-hash', size: 10 },
  beta: { kind: 'file', hash: 'remote-hash', size: 11 }
}

class MemorySessionStore implements DevboxSyncSessionStore {
  readonly removed: string[] = []
  private readonly sessions = new Map<string, DevboxSyncSessionIdentity>()

  list(): readonly DevboxSyncSessionIdentity[] {
    return [...this.sessions.values()]
  }

  upsert(session: DevboxSyncSessionIdentity): void {
    this.sessions.set(`${session.profileId}:${session.sessionId}`, session)
  }

  remove(session: DevboxSyncSessionIdentity): void {
    this.removed.push(session.sessionId)
    this.sessions.delete(`${session.profileId}:${session.sessionId}`)
  }
}

class MemoryConflictStore implements DevboxSyncConflictStore {
  constructor(private readonly conflicts: DevboxSyncConflict[] = []) {}

  list(): readonly DevboxSyncConflict[] {
    return [...this.conflicts]
  }

  remove(conflictId: string): void {
    const index = this.conflicts.findIndex((candidate) => candidate.conflictId === conflictId)
    if (index >= 0) {
      this.conflicts.splice(index, 1)
    }
  }
}

class MemoryBackupStore implements DevboxSyncBackupStore {
  private readonly handles = new Set<string>()

  async create(candidate: DevboxSyncConflict): Promise<DevboxSyncBackupHandle> {
    const handle = {
      id: `backup-${candidate.conflictId}`,
      conflictId: candidate.conflictId,
      localHash: candidate.local.hash,
      remoteHash: candidate.remote.hash,
      createdAt: 100
    }
    this.handles.add(handle.id)
    return handle
  }

  async has(handle: DevboxSyncBackupHandle): Promise<boolean> {
    return this.handles.has(handle.id)
  }
}

function rawSession(overrides: Partial<MutagenSessionRecord> = {}): MutagenSessionRecord {
  return {
    identifier: 'mutagen-id-1',
    name: 'devbox-working-session-1',
    labels: {
      'devbox-profile': 'profile-1',
      'devbox-session': 'session-1',
      'devbox-root-class': 'working',
      'devbox-backend': 'mutagen'
    },
    paused: false,
    status: 'watching',
    successfulCycles: 1,
    conflicts: [],
    watch: { mode: 'portable', native: true, pollingInterval: 10 },
    lastChangeAt: null,
    lastSynchronizedAt: null,
    ...overrides
  }
}

class FakeMutagenClient implements MutagenSessionClient {
  readonly paused: string[] = []
  readonly terminated: string[] = []
  daemonStopped = 0
  readonly created: MutagenCreateSessionOptions[] = []
  readonly sessions: MutagenSessionRecord[] = []
  private nextIdentifier = 1

  constructor(initial: readonly MutagenSessionRecord[] = []) {
    this.sessions.push(...initial)
  }

  async createSession(
    _request: typeof request,
    options: MutagenCreateSessionOptions
  ): Promise<MutagenSessionRecord> {
    this.created.push(options)
    const created = rawSession({
      identifier: `mutagen-created-${this.nextIdentifier++}`,
      name: options.name,
      labels: options.labels,
      watch: { mode: 'portable', native: true, pollingInterval: options.pollingIntervalSeconds ?? 10 }
    })
    this.sessions.push(created)
    return created
  }

  async listSessions(): Promise<readonly MutagenSessionRecord[]> {
    return [...this.sessions]
  }

  async pause(identifier: string): Promise<void> {
    this.paused.push(identifier)
    const session = this.sessions.find((candidate) => candidate.identifier === identifier)
    if (session) {
      session.paused = true
    }
  }

  readonly calls: string[] = []

  async resume(identifier: string): Promise<void> {
    this.calls.push(`resume:${identifier}`)
    const session = this.sessions.find((candidate) => candidate.identifier === identifier)
    if (session) {
      session.paused = false
    }
  }

  async flush(identifier: string): Promise<void> {
    this.calls.push(`flush:${identifier}`)
  }

  async terminate(identifier: string): Promise<void> {
    this.terminated.push(identifier)
    const index = this.sessions.findIndex((candidate) => candidate.identifier === identifier)
    if (index >= 0) {
      this.sessions.splice(index, 1)
    }
  }

  async daemonStop(): Promise<void> {
    this.daemonStopped += 1
  }
}

class StubbornMutagenClient extends FakeMutagenClient {
  override async terminate(identifier: string): Promise<void> {
    this.terminated.push(identifier)
  }
}

function makeBackend(
  cli: FakeMutagenClient,
  overrides: Partial<{
    sessionStore: MemorySessionStore
    conflictStore: MemoryConflictStore
    backupStore: MemoryBackupStore
    transportIdentity: { isCurrent(): boolean }
    resolveConflict: MutagenSyncBackendOptions['resolveConflict']
  }> = {}
) {
  return new MutagenSyncBackend({
    profileId: 'profile-1',
    cli,
    sessionStore: overrides.sessionStore ?? new MemorySessionStore(),
    conflictStore: overrides.conflictStore ?? new MemoryConflictStore(),
    backupStore: overrides.backupStore ?? new MemoryBackupStore(),
    transportIdentity: overrides.transportIdentity,
    resolveConflict: overrides.resolveConflict,
    now: () => 100
  })
}

describe('MutagenSyncBackend', () => {
  it('observes live labeled sessions without creating them in a fresh process', async () => {
    const cli = new FakeMutagenClient([rawSession()])
    const backend = makeBackend(cli)
    await expect(backend.observe(request)).resolves.toMatchObject({
      session: expect.objectContaining({ sessionId: 'session-1' }),
      phase: 'watching-native'
    })
    expect(cli.created).toHaveLength(0)
  })

  it('shuts down every owned live session from the label query and keeps the shared daemon for other sessions', async () => {
    const second = rawSession({
      identifier: 'mutagen-id-2',
      labels: {
        'devbox-profile': 'profile-1',
        'devbox-session': 'session-2',
        'devbox-root-class': 'cache',
        'devbox-backend': 'mutagen'
      }
    })
    const foreign = rawSession({ identifier: 'foreign-id', labels: { owner: 'other' } })
    const cli = new FakeMutagenClient([rawSession(), second, foreign])
    const backend = makeBackend(cli)
    await backend.shutdownForDisable()
    expect(cli.terminated).toEqual(['mutagen-id-1', 'mutagen-id-2'])
    expect(cli.sessions).toEqual([foreign])
    expect(cli.daemonStopped).toBe(0)
  })

  it('stops the daemon on disable only when no session of any profile remains', async () => {
    const cli = new FakeMutagenClient([rawSession()])
    await makeBackend(cli).shutdownForDisable()
    expect(cli.sessions).toEqual([])
    expect(cli.daemonStopped).toBe(1)
  })

  it('fails disable when a live owned session survives termination', async () => {
    const cli = new StubbornMutagenClient([rawSession()])
    const backend = makeBackend(cli)
    await expect(backend.shutdownForDisable()).rejects.toMatchObject({
      code: 'operation_conflict',
      context: { field: 'active-session-on-disable' }
    })
    expect(cli.daemonStopped).toBe(0)
  })

  it('passes the profile entry cap into new Mutagen sessions', async () => {
    const cli = new FakeMutagenClient()
    const backend = makeBackend(cli)
    await backend.create(request)
    expect(cli.created[0]).toMatchObject({ maxEntryCount: 234_567 })
  })

  it('passes the profile watch polling override to new Mutagen sessions', async () => {
    const cli = new FakeMutagenClient()
    const backend = makeBackend(cli)
    await backend.create({ ...request, watchPollingIntervalSeconds: 60 })
    expect(cli.created[0]).toMatchObject({ pollingIntervalSeconds: 60 })
  })

  it('refuses to adopt a session with a mismatched or unverifiable polling interval', async () => {
    const mismatched = makeBackend(new FakeMutagenClient([rawSession()]))
    await expect(mismatched.create({ ...request, watchPollingIntervalSeconds: 60 })).rejects.toMatchObject({
      code: 'operation_conflict',
      context: { field: 'watch-polling-interval-mismatch' }
    })

    const unverifiable = makeBackend(new FakeMutagenClient([rawSession({
      watch: { mode: 'portable', native: true, pollingInterval: null }
    })]))
    await expect(unverifiable.create(request)).rejects.toMatchObject({
      code: 'operation_conflict',
      context: { field: 'watch-polling-interval-unverified' }
    })
  })

  it('accepts resolved mode and reports a non-degraded capability', async () => {
    const cli = new FakeMutagenClient()
    const backend = makeBackend(cli)
    await backend.create({
      ...request,
      mode: 'two-way-resolved',
      exclusionPolicy: 'explicit-only',
      excludes: ['*_lock.json']
    })

    expect(cli.created[0]).toMatchObject({
      exclusionPolicy: 'explicit-only',
      excludes: ['*_lock.json']
    })
    await expect(backend.status()).resolves.toMatchObject({
      capability: 'two-way-safe',
      direction: null,
      conflictCount: 0,
      problemCount: 0,
      lastError: null
    })
  })

  it('allows distinct credential sessions to share the credentials root class', async () => {
    const cli = new FakeMutagenClient()
    const first = makeBackend(cli)
    const second = makeBackend(cli)
    await first.create({
      ...request,
      sessionId: 'profile-credentials-mcp-auth',
      rootClassId: 'credentials',
      localRoot: '/local/.mcp-auth',
      remoteRoot: '/remote/.mcp-auth',
      mode: 'two-way-resolved'
    })
    await expect(
      second.create({
        ...request,
        sessionId: 'profile-credentials-provider-cache',
        rootClassId: 'credentials',
        localRoot: '/local/.provider-cache',
        remoteRoot: '/remote/.provider-cache',
        mode: 'two-way-resolved'
      })
    ).resolves.toMatchObject({ sessionId: 'profile-credentials-provider-cache' })
    expect(cli.created).toHaveLength(2)
  })

  it('accepts one-way-replica paste mirrors and still refuses directional requests', async () => {
    const cli = new FakeMutagenClient()
    const backend = makeBackend(cli)
    await expect(
      backend.create({
        ...request,
        sessionId: 'profile-paste-clipboard',
        rootClassId: 'paste',
        localRoot: '/tmp/devbox-temp/ab/cd/T',
        remoteRoot: '/tmp/devbox-temp/ab/cd/T',
        mode: 'one-way-replica',
        exclusionPolicy: 'explicit-only',
        excludes: ['*', '!terminal-paste-*']
      })
    ).resolves.toMatchObject({ sessionId: 'profile-paste-clipboard', rootClassId: 'paste' })
    expect(cli.created[0]).toMatchObject({
      name: 'devbox-paste-profile-paste-clipboard',
      excludes: ['*', '!terminal-paste-*'],
      exclusionPolicy: 'explicit-only'
    })
    await expect(
      makeBackend(cli).create({
        ...request,
        sessionId: 'profile-directional',
        mode: 'directional',
        direction: 'local-to-remote'
      })
    ).rejects.toMatchObject({ code: 'operation_conflict', context: { field: 'mutagen-two-way-safe-request' } })
  })

  it('surfaces Mutagen errors, problems, and conflicts as degraded status', async () => {
    const cli = new FakeMutagenClient([rawSession({
      lastError: 'beta scan error: remote error: exceeded allowed entry count',
      problems: ['scan failed'],
      conflicts: [conflict]
    })])
    const backend = makeBackend(cli)
    await backend.observe(request)
    const current = await backend.status()
    expect(current).toMatchObject({
      phase: 'conflicted',
      lastError: 'beta scan error: remote error: exceeded allowed entry count',
      problemCount: 1,
      conflictCount: 1,
      observation: { freshness: 'stale' }
    })
  })

  it('creates one labeled session per root class and rediscoveries do not duplicate it', async () => {
    const cli = new FakeMutagenClient()
    const backend = makeBackend(cli)
    await expect(backend.create(request)).resolves.toMatchObject({
      sessionId: 'session-1',
      rootClassId: 'working',
      backend: 'mutagen'
    })
    expect(cli.created).toHaveLength(1)

    const restarted = makeBackend(cli)
    await restarted.create(request)
    expect(cli.created).toHaveLength(1)
    await expect(restarted.listSessions()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'session-1', rootClassId: 'working' })
    ])

    cli.sessions.splice(0)
    const afterDaemonRestart = makeBackend(cli)
    await afterDaemonRestart.create(request)
    expect(cli.created).toHaveLength(2)
    expect(cli.sessions).toHaveLength(1)
  })

  it('never lists, pauses, or terminates a foreign/unlabeled session', async () => {
    const foreign = rawSession({
      identifier: 'foreign-id',
      labels: { 'some-user-label': 'foreign' }
    })
    const cli = new FakeMutagenClient([foreign])
    const backend = makeBackend(cli)
    await backend.create(request)
    await expect(backend.listSessions()).resolves.toHaveLength(1)
    await expect(backend.terminate('foreign-session')).rejects.toMatchObject({
      code: 'operation_conflict'
    })
    expect(cli.paused).not.toContain('foreign-id')
    expect(cli.terminated).not.toContain('foreign-id')
  })

  it('terminates any owned labeled session by id and leaves foreign sessions untouched', async () => {
    const owned = rawSession()
    const secondOwned = rawSession({
      identifier: 'mutagen-id-2',
      labels: {
        'devbox-profile': 'profile-1',
        'devbox-session': 'session-2',
        'devbox-root-class': 'cache',
        'devbox-backend': 'mutagen'
      }
    })
    const foreign = rawSession({
      identifier: 'foreign-id',
      labels: { 'some-user-label': 'foreign' }
    })
    const cli = new FakeMutagenClient([owned, secondOwned, foreign])
    const backend = makeBackend(cli)

    await backend.create(request)
    await backend.terminate('session-2')
    await backend.terminate('session-1')

    expect(cli.terminated).toEqual(['mutagen-id-2', 'mutagen-id-1'])
    expect(cli.sessions).toEqual([foreign])
  })

  it('never leaves a session running: resume and flush are one resume → flush → pause cycle', async () => {
    const cli = new FakeMutagenClient([rawSession({ paused: true })])
    const backend = makeBackend(cli)
    await backend.create(request)
    await backend.resume()
    await backend.flush()
    const id = cli.sessions[0]!.identifier
    expect(cli.calls).toEqual([`resume:${id}`, `flush:${id}`, `resume:${id}`, `flush:${id}`])
    expect(cli.paused).toEqual([id, id])
    expect(cli.sessions[0]!.paused).toBe(true)
    await expect(backend.status()).resolves.toMatchObject({ phase: 'paused' })
  })

  it('maps conflicts and requires exact hashes plus a backup before resolution', async () => {
    const cli = new FakeMutagenClient([rawSession({ conflicts: [conflict] })])
    const backupStore = new MemoryBackupStore()
    const resolveConflict = vi.fn(async () => undefined)
    const backend = makeBackend(cli, { backupStore, resolveConflict })
    await backend.create(request)
    const conflicts = await backend.listConflicts()
    expect(conflicts).toMatchObject([
      {
        path: 'src/index.ts',
        class: 'content',
        local: { hash: 'local-hash' },
        remote: { hash: 'remote-hash' }
      }
    ])
    await expect(
      backend.resolveConflict({
        conflictId: conflicts[0].conflictId,
        expectedLocalHash: 'changed',
        expectedRemoteHash: 'remote-hash',
        backupHandle: {
          id: 'bad',
          conflictId: conflicts[0].conflictId,
          localHash: 'changed',
          remoteHash: 'remote-hash',
          createdAt: 100
        },
        winner: 'local'
      })
    ).rejects.toMatchObject({ code: 'operation_conflict' })
    expect(resolveConflict).not.toHaveBeenCalled()

    const backup = await backend.createConflictBackup(conflicts[0].conflictId)
    await expect(
      backend.resolveConflict({
        conflictId: conflicts[0].conflictId,
        expectedLocalHash: 'local-hash',
        expectedRemoteHash: 'remote-hash',
        backupHandle: backup,
        winner: 'local'
      })
    ).resolves.toMatchObject({ winner: 'local' })
    expect(resolveConflict).toHaveBeenCalledTimes(1)
    // Resolution leaves the session paused; the next `db sync` carries it.
    expect(cli.calls.some((call) => call.startsWith('resume:'))).toBe(false)
    expect(cli.sessions[0]!.paused).toBe(true)
  })

  it('pauses when the resolved endpoint or approved fingerprint changes', async () => {
    const identity = {
      current: true,
      isCurrent() {
        return this.current
      }
    }
    const cli = new FakeMutagenClient()
    const backend = makeBackend(cli, { transportIdentity: identity })
    await backend.create(request)
    identity.current = false
    await expect(backend.status()).resolves.toMatchObject({
      phase: 'paused',
      observation: { freshness: 'stale' }
    })
    expect(cli.paused).toContain('mutagen-created-1')
    await expect(backend.resume()).rejects.toMatchObject({ code: 'ssh_identity_mismatch' })
  })
})
