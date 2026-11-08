import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { parseArgs } from './args'
import { createDevboxProfileSshTarget } from './profile-ssh'
import { setDevboxProfileProxyCommand, showDevboxProfileProxyCommand } from './profile-proxy-command'

const PROXY = '/Users/u/.local/bin/devbox proxy'
const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'aws',
  displayName: 'aws',
  sshTarget: { targetId: 'target-aws', identity: { host: 'devbox', port: 22, username: 'alice', hostKeyFingerprint: 'SHA256:abc123' } },
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

describe('profile proxy-command', () => {
  it('sets, shows and clears the ProxyCommand on an existing profile and every ssh spawn picks it up', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'devbox-proxy-profile-')), 'profiles')
    const store = new DevboxProfileStore({ rootDir: root })
    expect(store.saveProfile(profile).status).toBe('saved')
    expect(showDevboxProfileProxyCommand(root, {}, 'aws')).toEqual({ profileId: 'aws', proxyCommand: null })
    expect(setDevboxProfileProxyCommand(root, {}, 'aws', ` ${PROXY} `)).toEqual({ profileId: 'aws', proxyCommand: PROXY })
    const target = createDevboxProfileSshTarget('aws', root, store)
    expect(target.local).toBe(false)
    expect(target.endpoint.extraOptions).toEqual([`ProxyCommand=${PROXY}`, 'HostKeyAlias=devbox'])
    expect(setDevboxProfileProxyCommand(root, {}, 'aws', undefined)).toEqual({ profileId: 'aws', proxyCommand: null })
    expect(createDevboxProfileSshTarget('aws', root, store).endpoint).not.toHaveProperty('extraOptions')
    expect(() => setDevboxProfileProxyCommand(root, {}, 'aws', 'a\nb')).toThrow('newlines')
    expect(() => setDevboxProfileProxyCommand(root, {}, 'missing', PROXY)).toThrow()
  })

  it('parses the quoted command as one positional argument', () => {
    expect(parseArgs(['profile', 'proxy-command', 'set', PROXY, '--profile', 'aws'])).toMatchObject({ commandPath: ['profile', 'proxy-command', 'set'], positionalArgs: [PROXY] })
    expect(parseArgs(['init', '--host', 'devbox', '--proxy-command', PROXY]).flags.get('proxy-command')).toBe(PROXY)
  })
})
