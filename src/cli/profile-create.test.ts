import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProfile, type ScannedKey } from './profile-create'

const env = {}
const key: ScannedKey = {
  type: 'ssh-ed25519',
  blob: Buffer.from('fixture-host-key'),
  line: 'example.test ssh-ed25519 Zml4dHVyZS1ob3N0LWtleQ==\n'
}

describe('profile create', () => {
  it('rejects a fingerprint that is not returned by ssh-keyscan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-cli-'))
    await expect(createProfile({
      profileId: 'p1', host: 'example.test', port: 22, username: 'dev',
      localRoot: '/workspace', remoteRoot: '/workspace',
      fingerprint: 'SHA256:not-the-host', yes: true, force: false
    }, { profileRoot: root, env, keyscan: async () => [key] })).rejects.toMatchObject({
      code: 'ssh_identity_mismatch'
    })
  })

  it('dry-runs roaming inventory without writing profile or known_hosts state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-cli-dry-run-'))
    const result = await createProfile({ profileId: 'roam', host: 'example.test', port: 22, username: 'dev', localRoot: '/workspace', remoteRoot: '/remote/workspace', yes: true, force: false, gitRoaming: true, dryRun: true }, { profileRoot: root, env, keyscan: async () => [key], roamingPreflight: async (profile, keys) => ({ status: 'ready', profileId: profile.id, keyCount: keys.length }) })
    expect(result.dryRun).toBe(true)
    expect(result.inventory).toEqual({ status: 'ready', profileId: 'roam', keyCount: 1 })
    await expect(readFile(join(root, 'roam.json'), 'utf8')).rejects.toThrow()
    await expect(stat(join(root, 'roam', 'known_hosts'))).rejects.toThrow()
  })

  it('persists repeatable create-time ignore patterns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-cli-ignore-'))
    const result = await createProfile({ profileId: 'roam', host: 'example.test', port: 22, username: 'dev', localRoot: '/workspace', remoteRoot: '/remote/workspace', yes: true, force: false, gitRoaming: true, ignore: ['.env', '**/ignored/'] }, { profileRoot: root, env, keyscan: async () => [key] })
    expect(result.profile.gitRoaming?.ignorePatterns).toEqual([
      { pattern: '.env', rootClass: 'portable-working' },
      { pattern: '**/ignored/', rootClass: 'portable-working' }
    ])
    expect(result.profile.sync.excludes).toContain('.env')
  })

  it('persists an accepted profile and pinned known_hosts with restrictive modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-cli-'))
    const result = await createProfile({
      profileId: 'p1', host: 'example.test', port: 22, username: 'dev',
      localRoot: '/workspace', remoteRoot: '/workspace', yes: true, force: false
    }, { profileRoot: root, env, keyscan: async () => [key] })
    expect(result.profile.sshTarget.identity.hostKeyFingerprint).toMatch(/^SHA256:/)
    expect(await readFile(result.knownHostsFile, 'utf8')).toContain('ssh-ed25519')
    expect((await stat(result.knownHostsFile)).mode & 0o777).toBe(0o600)
  })

  it('pins a ProxyCommand and hands it to the key scan instead of ssh-keyscan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-cli-proxy-'))
    const scans: unknown[] = []
    const result = await createProfile({
      profileId: 'aws', host: 'devbox', port: 22, username: 'alice', proxyCommand: ' /home/u/.local/bin/devbox proxy ',
      localRoot: '/workspace', remoteRoot: '/home/alice/workspace', yes: true, force: false
    }, { profileRoot: root, env, keyscan: async (...args) => { scans.push(args); return [{ ...key, line: 'devbox ssh-ed25519 Zml4dHVyZS1ob3N0LWtleQ==\n' }] } })
    expect(scans).toEqual([['devbox', 22, { proxyCommand: '/home/u/.local/bin/devbox proxy', username: 'alice' }]])
    expect(result.profile.sshTarget).toMatchObject({ identity: { host: 'devbox' }, proxyCommand: '/home/u/.local/bin/devbox proxy' })
    expect(JSON.parse(await readFile(join(root, 'aws.json'), 'utf8')).sshTarget.proxyCommand).toBe('/home/u/.local/bin/devbox proxy')
    expect(await readFile(result.knownHostsFile, 'utf8')).toBe('devbox ssh-ed25519 Zml4dHVyZS1ob3N0LWtleQ==\n')
    await expect(createProfile({
      profileId: 'bad', host: 'devbox', port: 22, username: 'alice', proxyCommand: 'a\nb',
      localRoot: '/workspace', remoteRoot: '/workspace', yes: true, force: false
    }, { profileRoot: root, env, keyscan: async () => [key] })).rejects.toMatchObject({ code: 'operation_conflict', context: { field: 'proxy-command' } })
  })

  it('leaves a direct profile without a proxyCommand field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-cli-direct-'))
    const scans: unknown[] = []
    const result = await createProfile({ profileId: 'd', host: 'example.test', port: 22, username: 'dev', localRoot: '/workspace', remoteRoot: '/workspace', yes: true, force: false }, { profileRoot: root, env, keyscan: async (...args) => { scans.push(args); return [key] } })
    expect(scans).toEqual([['example.test', 22, undefined]])
    expect('proxyCommand' in result.profile.sshTarget).toBe(false)
  })
})
