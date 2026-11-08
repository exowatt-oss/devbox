import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DevboxProfileStore, normalizeDevboxProfile } from './devbox-profile-store'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'profile-1',
  displayName: 'Remote devbox',
  sshTarget: {
    targetId: 'target-1',
    identity: {
      host: 'devbox.example.test',
      port: 22,
      username: 'sample',
      hostKeyFingerprint: 'SHA256:abc123'
    }
  },
  roots: { localRoot: '/local/project', remoteRoot: '/remote/project' },
  pathMap: [
    { id: 'source', localRelativePath: 'src', remoteRelativePath: 'src', syncClassId: 'working' }
  ],
  toolchain: { lockId: 'lock-1', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [
      {
        id: 'working',
        kind: 'portable-working',
        backend: 'mutagen',
        mode: 'two-way-safe',
        excludes: []
      }
    ],
    defaultClassId: 'working',
    excludes: []
  },
  credentials: [
    {
      kind: 'provider-auth',
      referenceId: 'github-ref',
      provider: 'github',
      delivery: 'remote-enrollment'
    }
  ],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
  featureDefaults: { detachedJobs: false, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 10_000,
    reconnectTargetMs: 20_000,
    operationRecoveryTargetMs: 30_000,
    offlineEdits: 'warn'
  }
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'devbox-profile-'))
}

describe('DevboxProfileStore', () => {
  it('leaves old unrelated stores untouched when no Devbox profile exists', () => {
    const rootDir = temporaryRoot()
    const legacyPath = join(rootDir, 'devbox-data.json')
    const legacyContents = '{"schemaVersion":42,"unrelated":true}\n'
    writeFileSync(legacyPath, legacyContents)
    const store = new DevboxProfileStore({
      rootDir: join(rootDir, 'devbox', 'profiles')
    })
    expect(store.loadProfile('profile-1')).toEqual({ status: 'missing' })
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyContents)
  })

  it('normalizes and atomically saves a valid profile', () => {
    const rootDir = join(temporaryRoot(), 'profiles')
    const store = new DevboxProfileStore({ rootDir })
    const saved = store.saveProfile({ ...profile, displayName: '  Remote devbox  ' })
    expect(saved).toMatchObject({ status: 'saved', profile: { displayName: 'Remote devbox' } })
    const loaded = store.loadProfile('profile-1')
    expect(loaded).toMatchObject({ status: 'loaded', profile: { id: 'profile-1' } })
    expect(existsSync(join(rootDir, 'profile-1.json'))).toBe(true)
    expect(store.listProfiles().map((item) => item.id)).toEqual(['profile-1'])
  })

  it('preserves malformed or newer profile bytes while reporting them as disabled', () => {
    const rootDir = join(temporaryRoot(), 'profiles')
    const path = join(rootDir, 'profile-1.json')
    const malformed = JSON.stringify({ ...profile, secret: 'never' })
    const newer = JSON.stringify({ ...profile, schemaVersion: 99 })
    mkdirSync(rootDir, { recursive: true })
    const store = new DevboxProfileStore({ rootDir })
    for (const raw of [malformed, newer]) {
      writeFileSync(path, raw)
      const result = store.loadProfile('profile-1')
      expect(result.status).toBe('disabled')
      expect(readFileSync(path, 'utf8')).toBe(raw)
    }
  })

  it('accepts and normalizes a positive watch polling override', () => {
    const result = normalizeDevboxProfile({ ...profile, sync: { ...profile.sync, watchPollingIntervalSeconds: 60 } })
    expect(result).toMatchObject({ ok: true, profile: { sync: { watchPollingIntervalSeconds: 60, maxEntryCount: 2_000_000 } } })
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeDevboxProfile({ ...profile, sync: { ...profile.sync, watchPollingIntervalSeconds: value } })).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })

  it('round-trips an optional ssh ProxyCommand and rejects empty or multi-line values', () => {
    const proxied = { ...profile, sshTarget: { ...profile.sshTarget, proxyCommand: '/home/u/.local/bin/devbox proxy' } }
    expect(normalizeDevboxProfile(proxied)).toMatchObject({ ok: true, profile: { sshTarget: { proxyCommand: '/home/u/.local/bin/devbox proxy' } } })
    const direct = normalizeDevboxProfile(profile)
    expect(direct.ok && 'proxyCommand' in direct.profile.sshTarget).toBe(false)
    for (const proxyCommand of ['', '   ', 'nc a 22\nid', 'nc a 22\r', 'nc\u0000', 42]) {
      expect(normalizeDevboxProfile({ ...profile, sshTarget: { ...profile.sshTarget, proxyCommand } }), String(proxyCommand)).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })

  it('round-trips an absolute remote shell directory', () => {
    const result = normalizeDevboxProfile({ ...profile, shellDir: '/home/sample' })
    expect(result).toMatchObject({ ok: true, profile: { shellDir: '/home/sample' } })
    expect(normalizeDevboxProfile({ ...profile, shellDir: 'relative' })).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('round-trips a normalized credential sync configuration', () => {
    const rootDir = join(temporaryRoot(), 'profiles')
    const store = new DevboxProfileStore({ rootDir })
    const credentialSync = {
      enabled: true,
      roots: [
        { id: 'z-root', localRoot: '/local/z', remoteRoot: '/remote/z', excludes: ['*.log', '*.log'] },
        { id: 'a-root', localRoot: '/local/a', remoteRoot: '/remote/a', excludes: ['first'] }
      ]
    }
    const saved = store.saveProfile({ ...profile, credentialSync })
    expect(saved).toMatchObject({
      status: 'saved',
      profile: {
        credentialSync: {
          enabled: true,
          roots: [
            { id: 'a-root', excludes: ['first'] },
            { id: 'z-root', excludes: ['*.log'] }
          ]
        }
      }
    })
    expect(saved.status).toBe('saved')
    if (saved.status === 'saved') {
      expect(store.loadProfile('profile-1')).toEqual({ status: 'loaded', profile: saved.profile })
    }
  })

  it('loads a legacy profile without credential sync unchanged', () => {
    const result = normalizeDevboxProfile(profile)
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.profile).not.toHaveProperty('credentialSync')
    }
  })

  it('rejects malformed credential sync data', () => {
    const malformed = {
      ...profile,
      credentialSync: {
        enabled: true,
        roots: [{ id: 'bad root', localRoot: 'relative', remoteRoot: '/remote', excludes: [] }]
      }
    }
    expect(normalizeDevboxProfile(malformed)).toMatchObject({ ok: false, reason: 'malformed' })
    expect(new DevboxProfileStore({ rootDir: join(temporaryRoot(), 'profiles') }).saveProfile(malformed)).toMatchObject({
      status: 'disabled',
      reason: 'malformed-profile'
    })
  })

  it('round-trips a normalized paste sync configuration and rejects malformed patterns', () => {
    const rootDir = join(temporaryRoot(), 'profiles')
    const store = new DevboxProfileStore({ rootDir })
    const pasteSync = {
      enabled: true,
      roots: [
        { id: 'z-root', localRoot: '/tmp/devbox-temp/z/T', remoteRoot: '/tmp/devbox-temp/z/T', patterns: ['terminal-paste-*', 'terminal-paste-*'] },
        { id: 'clipboard', localRoot: '/tmp/devbox-temp/a/T', remoteRoot: '/tmp/paste', patterns: ['terminal-paste-*'] }
      ]
    }
    const saved = store.saveProfile({ ...profile, pasteSync })
    expect(saved).toMatchObject({
      status: 'saved',
      profile: {
        pasteSync: {
          enabled: true,
          roots: [
            { id: 'clipboard', remoteRoot: '/tmp/paste' },
            { id: 'z-root', patterns: ['terminal-paste-*']}
          ]
        }
      }
    })
    if (saved.status === 'saved') {
      expect(store.loadProfile('profile-1')).toEqual({ status: 'loaded', profile: saved.profile })
    }
    expect(normalizeDevboxProfile(profile)).toMatchObject({ ok: true })
    for (const patterns of [[], ['*'], ['../x'], ['a/b'], ['!neg']]) {
      expect(normalizeDevboxProfile({
        ...profile,
        pasteSync: { enabled: true, roots: [{ id: 'clipboard', localRoot: '/a', remoteRoot: '/a', patterns }] }
      })).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })

  it('round-trips an absolute local credential env-file path without storing values', () => {
    const rootDir = join(temporaryRoot(), 'profiles')
    const store = new DevboxProfileStore({ rootDir })
    const envFile = '/Users/exampleuser/.pi/agent/secrets.env'
    const saved = store.saveProfile({ ...profile, envFile })
    expect(saved).toMatchObject({ status: 'saved', profile: { envFile } })
    expect(store.loadProfile('profile-1')).toMatchObject({
      status: 'loaded',
      profile: { envFile }
    })
    expect(normalizeDevboxProfile({ ...profile, envFile: 'relative.env' })).toMatchObject({
      ok: false,
      reason: 'malformed'
    })
  })

  it('normalizes path and collection ordering without adding secret-bearing fields', () => {
    const result = normalizeDevboxProfile({
      ...profile,
      displayName: '  Remote devbox  ',
      pathMap: profile.pathMap.toReversed(),
      credentials: profile.credentials.toReversed()
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.profile.displayName).toBe('Remote devbox')
      expect(result.profile.sync.maxEntryCount).toBe(2_000_000)
      expect(result.profile.pathMap.map((entry) => entry.id)).toEqual(['source'])
      expect(result.profile.credentials[0]?.referenceId).toBe('github-ref')
    }
  })

  it('rejects a newer profile and secret-like credential fields', () => {
    expect(normalizeDevboxProfile({ ...profile, schemaVersion: 2 })).toMatchObject({
      ok: false,
      reason: 'newer-version'
    })
    expect(
      normalizeDevboxProfile({
        ...profile,
        credentials: [
          {
            kind: 'provider-auth',
            referenceId: 'github-ref',
            provider: 'github',
            delivery: 'remote-enrollment',
            secret: 'must-not-cross-the-contract'
          }
        ]
      })
    ).toMatchObject({ ok: false, reason: 'malformed' })
  })
})
