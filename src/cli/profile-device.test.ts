import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setDevboxProfileDevice, showDevboxProfileDevice } from './profile-device'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxProfileStore } from '../core/devbox-profile-store'

function makeProfile(id: string): DevboxProfileV1 {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    sshTarget: { targetId: `t-${id}`, identity: { host: 'host', port: 22, username: 'user', hostKeyFingerprint: 'SHA256:abc123' } },
    roots: { localRoot: '/local', remoteRoot: '/remote' },
    pathMap: [{ id: 'workspace', localRelativePath: '.', remoteRelativePath: '.', syncClassId: 'working' }],
    toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
    sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] },
    credentials: [], defaultAuthority: 'remote',
    projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
    featureDefaults: { detachedJobs: true, closedSessionHistory: true },
    slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
  }
}

function makeStore(): { profileRoot: string; store: DevboxProfileStore } {
  const profileRoot = join(mkdtempSync(join(tmpdir(), 'devbox-device-')), 'profiles')
  return { profileRoot, store: new DevboxProfileStore({ rootDir: profileRoot }) }
}

describe('profile device alias', () => {
  it('sets, shows, and clears a device alias', () => {
    const { profileRoot, store } = makeStore()
    expect(store.saveProfile(makeProfile('project')).status).toBe('saved')

    expect(showDevboxProfileDevice(profileRoot, {}, 'project')).toEqual({ profileId: 'project', device: null })
    expect(setDevboxProfileDevice(profileRoot, {}, 'project', 'workstation')).toEqual({ profileId: 'project', device: 'workstation' })
    expect(showDevboxProfileDevice(profileRoot, {}, 'project')).toEqual({ profileId: 'project', device: 'workstation' })
    expect(setDevboxProfileDevice(profileRoot, {}, 'project', undefined)).toEqual({ profileId: 'project', device: null })
    expect(showDevboxProfileDevice(profileRoot, {}, 'project')).toEqual({ profileId: 'project', device: null })
  })

  it('rejects an alias colliding with another profile id or device alias', () => {
    const { profileRoot, store } = makeStore()
    expect(store.saveProfile(makeProfile('project')).status).toBe('saved')
    expect(store.saveProfile(makeProfile('macmini')).status).toBe('saved')
    expect(setDevboxProfileDevice(profileRoot, {}, 'macmini', 'macmini-alias')).toEqual({ profileId: 'macmini', device: 'macmini-alias' })

    expect(() => setDevboxProfileDevice(profileRoot, {}, 'project', 'macmini')).toThrow(/collides with profile macmini/)
    expect(() => setDevboxProfileDevice(profileRoot, {}, 'project', 'macmini-alias')).toThrow(/collides with profile macmini/)
    // Re-setting a profile's own current alias to itself is not a collision.
    expect(setDevboxProfileDevice(profileRoot, {}, 'macmini', 'macmini-alias')).toEqual({ profileId: 'macmini', device: 'macmini-alias' })
  })

  it('rejects a malformed alias', () => {
    const { profileRoot, store } = makeStore()
    expect(store.saveProfile(makeProfile('project')).status).toBe('saved')
    expect(() => setDevboxProfileDevice(profileRoot, {}, 'project', '-bad')).toThrow(/must start with a letter or number/)
    expect(() => setDevboxProfileDevice(profileRoot, {}, 'project', 'has space')).toThrow(/must start with a letter or number/)
  })
})
