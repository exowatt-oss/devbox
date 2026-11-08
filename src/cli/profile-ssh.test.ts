import { mkdtempSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { createDevboxProfileSshTarget } from './profile-ssh'

function makeProfile(id: string, host: string): DevboxProfileV1 {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    sshTarget: { targetId: `target-${id}`, identity: { host, port: 22, username: userInfo().username, hostKeyFingerprint: 'SHA256:abc123' } },
    roots: { localRoot: '/tmp/local', remoteRoot: '/tmp/remote' },
    pathMap: [{ id: 'workspace', localRelativePath: '.', remoteRelativePath: '.', syncClassId: 'working' }],
    toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
    sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] },
    credentials: [],
    defaultAuthority: 'remote',
    projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
    featureDefaults: { detachedJobs: true, closedSessionHistory: true },
    slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
  }
}

function makeStore(): { root: string; store: DevboxProfileStore } {
  const root = join(mkdtempSync(join(tmpdir(), 'devbox-profile-ssh-')), 'profiles')
  return { root, store: new DevboxProfileStore({ rootDir: root }) }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createDevboxProfileSshTarget', () => {
  it('selects local execution for a profile pointing at this machine', () => {
    const { root, store } = makeStore()
    expect(store.saveProfile(makeProfile('local', hostname())).status).toBe('saved')
    const target = createDevboxProfileSshTarget('local', root, store)

    expect(target.local).toBe(true)
    expect(target.endpoint.username).toBe(userInfo().username)
    expect(target.interactive).toBeTypeOf('function')
    expect(target.ssh.command).toBeTypeOf('function')
  })

  it('keeps a remote profile on the system SSH runner', () => {
    const { root, store } = makeStore()
    expect(store.saveProfile(makeProfile('remote', 'devbox.invalid')).status).toBe('saved')
    const target = createDevboxProfileSshTarget('remote', root, store)

    expect(target.local).toBe(false)
    expect(target.endpoint.host).toBe('devbox.invalid')
  })

  it('allows local endpoints to be forced through SSH', () => {
    const { root, store } = makeStore()
    expect(store.saveProfile(makeProfile('forced', 'localhost')).status).toBe('saved')
    vi.stubEnv('DEVBOX_FORCE_REMOTE', '1')

    expect(createDevboxProfileSshTarget('forced', root, store).local).toBe(false)
  })
})
