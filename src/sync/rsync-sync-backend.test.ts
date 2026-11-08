import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  DevboxSyncBackupHandle,
  DevboxSyncBackupStore,
  DevboxSyncConflict,
  DevboxSyncConflictStore,
  DevboxSyncSessionIdentity,
  DevboxSyncSessionStore
} from './devbox-sync-backend'
import { RsyncSyncBackend, type RsyncCommandRunner } from './rsync-sync-backend'

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
  constructor(private readonly conflicts: DevboxSyncConflict[]) {}

  list(): readonly DevboxSyncConflict[] {
    return [...this.conflicts]
  }

  remove(conflictId: string): void {
    const index = this.conflicts.findIndex((conflict) => conflict.conflictId === conflictId)
    if (index >= 0) {
      this.conflicts.splice(index, 1)
    }
  }
}

class MemoryBackupStore implements DevboxSyncBackupStore {
  readonly events: string[] = []
  private readonly handles = new Set<string>()

  async create(conflict: DevboxSyncConflict): Promise<DevboxSyncBackupHandle> {
    this.events.push('backup-create')
    const handle = {
      id: `backup-${conflict.conflictId}`,
      conflictId: conflict.conflictId,
      localHash: conflict.local.hash,
      remoteHash: conflict.remote.hash,
      createdAt: 100
    }
    this.handles.add(handle.id)
    return handle
  }

  async has(handle: DevboxSyncBackupHandle): Promise<boolean> {
    this.events.push('backup-check')
    return this.handles.has(handle.id)
  }
}

const request = {
  profileId: 'profile-1',
  sessionId: 'session-1',
  rootClassId: 'working',
  localRoot: '/local/project',
  remoteRoot: '/remote/project',
  mode: 'directional' as const,
  direction: 'local-to-remote' as const
}

const conflict: DevboxSyncConflict = {
  conflictId: 'conflict-1',
  path: 'src/index.ts',
  local: { kind: 'file', hash: 'local-hash', size: 10 },
  remote: { kind: 'file', hash: 'remote-hash', size: 11 },
  class: 'content'
}

function makeBackend(
  overrides: Partial<{
    sessionStore: MemorySessionStore
    conflictStore: MemoryConflictStore
    backupStore: MemoryBackupStore
    commandRunner: RsyncCommandRunner
  }> = {}
) {
  const sessionStore = overrides.sessionStore ?? new MemorySessionStore()
  const conflictStore = overrides.conflictStore ?? new MemoryConflictStore([])
  const backupStore = overrides.backupStore ?? new MemoryBackupStore()
  const commandRunner =
    overrides.commandRunner ??
    vi.fn<RsyncCommandRunner>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  const backend = new RsyncSyncBackend({
    profileId: 'profile-1',
    commandRunner,
    sessionStore,
    conflictStore,
    backupStore,
    now: () => 100
  })
  return { backend, sessionStore, conflictStore, backupStore, commandRunner }
}

describe('RsyncSyncBackend', () => {
  it('advertises degraded-directional and refuses two-way-safe semantics', async () => {
    const { backend, commandRunner } = makeBackend()
    await expect(backend.create(request)).resolves.toMatchObject({
      profileId: 'profile-1',
      backend: 'rsync-fallback'
    })
    await expect(backend.status()).resolves.toMatchObject({
      capability: 'degraded-directional',
      direction: 'local-to-remote',
      watchMode: 'None',
      phase: 'staging'
    })
    expect(commandRunner).not.toHaveBeenCalled()

    const unsafe = { ...request, sessionId: 'unsafe', mode: 'two-way-safe' as const }
    const second = makeBackend()
    await expect(second.backend.create(unsafe)).rejects.toMatchObject({
      code: 'operation_conflict'
    })
  })

  it('uses injected rsync invocation, canonical filters, and never deletes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-rsync-'))
    try {
      const commandRunner = vi.fn<RsyncCommandRunner>().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: ''
      })
      const { backend } = makeBackend({ commandRunner })
      await backend.create({
        ...request,
        localRoot: join(root, 'local'),
        remoteRoot: join(root, 'remote')
      })
      await backend.flush()

      const [, args] = commandRunner.mock.calls[0] ?? []
      expect(args).toEqual(expect.arrayContaining(['--filter', '- .git/']))
      expect(args).toEqual(expect.arrayContaining(['--filter', '- .pi/agent/sessions/']))
      expect(args).not.toContain('--delete')
      expect(args?.at(-2)).toBe(`${join(root, 'local')}/`)
      expect(args?.at(-1)).toBe(join(root, 'remote'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits base exclusions for explicit-only roots', async () => {
    const commandRunner = vi.fn<RsyncCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: ''
    })
    const { backend } = makeBackend({ commandRunner })
    await backend.create({
      ...request,
      exclusionPolicy: 'explicit-only',
      excludes: ['*_lock.json']
    })
    await backend.flush()

    const [, args] = commandRunner.mock.calls[0] ?? []
    expect(args).toEqual(expect.arrayContaining(['--filter', '- *_lock.json']))
    expect(args).not.toContain('- .git/')
    expect(args).not.toContain('- **/*token*')
  })

  it('classifies an ENOSPC diagnostic even when rsync uses another exit code', async () => {
    const commandRunner = vi.fn<RsyncCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'write failed: ENOSPC'
    })
    const { backend } = makeBackend({ commandRunner })
    await backend.create(request)

    await expect(backend.flush()).rejects.toMatchObject({
      code: 'disk_pressure',
      retryable: true
    })
  })

  it('requires a pre-resolution backup and preserves the hash fence', async () => {
    const backupStore = new MemoryBackupStore()
    const conflictStore = new MemoryConflictStore([conflict])
    const commandRunner = vi.fn<RsyncCommandRunner>().mockImplementation(async () => {
      backupStore.events.push('runner')
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const { backend } = makeBackend({ conflictStore, backupStore, commandRunner })
    await backend.create(request)

    await expect(
      backend.resolveConflict({
        conflictId: conflict.conflictId,
        expectedLocalHash: undefined as unknown as string,
        expectedRemoteHash: conflict.remote.hash,
        backupHandle: {
          id: 'not-created',
          conflictId: conflict.conflictId,
          localHash: null,
          remoteHash: null,
          createdAt: 100
        },
        winner: 'local'
      })
    ).rejects.toMatchObject({ code: 'operation_conflict' })
    expect(commandRunner).not.toHaveBeenCalled()

    const backup = await backend.createConflictBackup(conflict.conflictId)
    const result = await backend.resolveConflict({
      conflictId: conflict.conflictId,
      expectedLocalHash: conflict.local.hash,
      expectedRemoteHash: conflict.remote.hash,
      backupHandle: backup,
      winner: 'local'
    })
    expect(result).toMatchObject({ conflictId: conflict.conflictId, winner: 'local' })
    expect(backupStore.events).toEqual(['backup-create', 'backup-check', 'runner'])
    expect(commandRunner).toHaveBeenCalledTimes(1)
    expect(await backend.listConflicts()).toEqual([])
  })

  it('lists and terminates only sessions carrying this profile labels', async () => {
    const sessionStore = new MemorySessionStore()
    sessionStore.upsert({
      profileId: 'foreign-profile',
      sessionId: 'foreign-session',
      rootClassId: 'working',
      backend: 'rsync-fallback',
      name: 'foreign',
      labels: {
        'devbox-profile': 'foreign-profile',
        'devbox-session': 'foreign-session',
        'devbox-root-class': 'working',
        'devbox-backend': 'rsync-fallback'
      }
    })
    sessionStore.upsert({
      profileId: 'foreign-profile',
      sessionId: 'session-1',
      rootClassId: 'working',
      backend: 'rsync-fallback',
      name: 'foreign-same-id',
      labels: {
        'devbox-profile': 'foreign-profile',
        'devbox-session': 'session-1',
        'devbox-root-class': 'working',
        'devbox-backend': 'rsync-fallback'
      }
    })
    const { backend } = makeBackend({ sessionStore })
    await backend.create(request)

    await expect(backend.listSessions()).resolves.toEqual([
      expect.objectContaining({ profileId: 'profile-1', sessionId: 'session-1' })
    ])
    await expect(backend.terminate('foreign-session')).rejects.toMatchObject({
      code: 'operation_conflict'
    })
    expect(sessionStore.removed).toEqual([])

    await backend.terminate('session-1')
    expect(sessionStore.removed).toEqual(['session-1'])
    expect(sessionStore.list()).toEqual([
      expect.objectContaining({ profileId: 'foreign-profile', sessionId: 'foreign-session' }),
      expect.objectContaining({ profileId: 'foreign-profile', sessionId: 'session-1' })
    ])
    expect(await backend.listSessions()).toEqual([])
    expect(await backend.status()).toMatchObject({ session: null, phase: 'unavailable' })
  })
})
