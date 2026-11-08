import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type {
  DevboxSyncBackupHandle,
  DevboxSyncBackupStore,
  DevboxSyncConflict,
  DevboxSyncConflictStore,
  DevboxSyncSessionIdentity,
  DevboxSyncSessionStore
} from '../../sync/devbox-sync-backend'
import { RsyncSyncBackend } from '../../sync/rsync-sync-backend'

const resourceRoot = mkdtempSync(join(tmpdir(), 'devbox-fault-resource-'))

afterAll(() => {
  rmSync(resourceRoot, { recursive: true, force: true })
})

const request = {
  profileId: 'fault-profile',
  sessionId: 'fault-rsync',
  rootClassId: 'working',
  localRoot: join(resourceRoot, 'local'),
  remoteRoot: join(resourceRoot, 'remote'),
  mode: 'directional' as const,
  direction: 'local-to-remote' as const
}

class MemorySessionStore implements DevboxSyncSessionStore {
  private readonly sessions = new Map<string, DevboxSyncSessionIdentity>()

  list(): readonly DevboxSyncSessionIdentity[] {
    return [...this.sessions.values()]
  }

  upsert(session: DevboxSyncSessionIdentity): void {
    this.sessions.set(session.sessionId, session)
  }

  remove(session: DevboxSyncSessionIdentity): void {
    this.sessions.delete(session.sessionId)
  }
}

class EmptyConflictStore implements DevboxSyncConflictStore {
  list(): readonly DevboxSyncConflict[] {
    return []
  }

  remove(): void {}
}

class MemoryBackupStore implements DevboxSyncBackupStore {
  async create(conflict: DevboxSyncConflict): Promise<DevboxSyncBackupHandle> {
    return {
      id: `backup-${conflict.conflictId}`,
      conflictId: conflict.conflictId,
      localHash: conflict.local.hash,
      remoteHash: conflict.remote.hash,
      createdAt: 1
    }
  }

  async has(): Promise<boolean> {
    return true
  }
}

function backend(
  commandRunner: (call: number) => { exitCode: number; stderr: string },
  now = 100
): { backend: RsyncSyncBackend; calls: () => number } {
  let callCount = 0
  const instance = new RsyncSyncBackend({
    profileId: request.profileId,
    commandRunner: async () => {
      callCount += 1
      const result = commandRunner(callCount)
      return { ...result, stdout: '' }
    },
    sessionStore: new MemorySessionStore(),
    conflictStore: new EmptyConflictStore(),
    backupStore: new MemoryBackupStore(),
    now: () => now
  })
  return { backend: instance, calls: () => callCount }
}

describe('Devbox fault harness: resource and transport faults', () => {
  it.each([
    ['permission denied', 13, 'Permission denied'],
    ['expired SSH authorization', 255, 'Permission denied (publickey)']
  ])('returns a typed non-success for %s', async (_fault, exitCode, stderr) => {
    const fixture = backend(() => ({ exitCode, stderr }))
    await fixture.backend.create(request)

    await expect(fixture.backend.flush()).rejects.toMatchObject({
      code: 'unknown',
      retryable: true
    })
    expect(await fixture.backend.status()).toMatchObject({
      phase: 'halted',
      observation: { freshness: 'unknown' }
    })
    expect(stderr).toContain('Permission')
  })

  it('maps a disk-full result to disk_pressure rather than generic unknown', async () => {
    const fixture = backend(() => ({ exitCode: 28, stderr: 'No space left on device' }))
    await fixture.backend.create(request)

    await expect(fixture.backend.flush()).rejects.toMatchObject({ code: 'disk_pressure' })
  })

  it('marks a previously fresh session stale after a network partition', async () => {
    const fixture = backend((call) =>
      call === 1
        ? { exitCode: 0, stderr: '' }
        : { exitCode: 12, stderr: 'failed to connect: network unreachable' }
    )
    await fixture.backend.create(request)
    await fixture.backend.flush()
    expect((await fixture.backend.status()).observation.freshness).toBe('fresh')

    await expect(fixture.backend.flush()).rejects.toMatchObject({ code: 'unknown' })
    const status = await fixture.backend.status()
    expect(status.phase).toBe('halted')
    expect(status.observation.freshness).toBe('stale')
    expect(fixture.calls()).toBe(2)
  })
})
