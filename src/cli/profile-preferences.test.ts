import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  setDevboxProfileMaxEntryCount,
  setDevboxProfileShellDir,
  setDevboxProfileWatchPollingInterval,
  showDevboxProfileMaxEntryCount,
  showDevboxProfileShellDir,
  showDevboxProfileWatchPollingInterval
} from './profile-preferences'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxProfileStore } from '../core/devbox-profile-store'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'p1',
  displayName: 'p1',
  sshTarget: { targetId: 't1', identity: { host: 'host', port: 22, username: 'user', hostKeyFingerprint: 'SHA256:abc123' } },
  roots: { localRoot: '/local', remoteRoot: '/remote' },
  pathMap: [{ id: 'workspace', localRelativePath: '.', remoteRelativePath: '.', syncClassId: 'working' }],
  toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
  sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] },
  credentials: [], defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
}

describe('profile sync entry-count preference', () => {
  it('persists a profile cap without pairing or touching a session', () => {
    const profileRoot = join(mkdtempSync(join(tmpdir(), 'devbox-entry-count-')), 'profiles')
    const store = new DevboxProfileStore({ rootDir: profileRoot })
    expect(store.saveProfile(profile).status).toBe('saved')
    expect(setDevboxProfileMaxEntryCount(profileRoot, {}, 'p1', 123_456)).toEqual({ profileId: 'p1', maxEntryCount: 123_456 })
    expect(showDevboxProfileMaxEntryCount(profileRoot, {}, 'p1')).toEqual({ profileId: 'p1', maxEntryCount: 123_456 })
    expect(setDevboxProfileMaxEntryCount(profileRoot, {}, 'p1', undefined)).toEqual({ profileId: 'p1', maxEntryCount: 2_000_000 })
  })
})

describe('profile watch polling interval preference', () => {
  it('persists an optional override and clears back to the 10-second default', () => {
    const profileRoot = join(mkdtempSync(join(tmpdir(), 'devbox-watch-polling-')), 'profiles')
    const store = new DevboxProfileStore({ rootDir: profileRoot })
    expect(store.saveProfile(profile).status).toBe('saved')
    expect(showDevboxProfileWatchPollingInterval(profileRoot, {}, 'p1')).toEqual({
      profileId: 'p1',
      watchPollingIntervalSeconds: null,
      effectiveWatchPollingIntervalSeconds: 10
    })
    expect(setDevboxProfileWatchPollingInterval(profileRoot, {}, 'p1', 60)).toEqual({
      profileId: 'p1',
      watchPollingIntervalSeconds: 60,
      effectiveWatchPollingIntervalSeconds: 60
    })
    expect(showDevboxProfileWatchPollingInterval(profileRoot, {}, 'p1')).toEqual({
      profileId: 'p1',
      watchPollingIntervalSeconds: 60,
      effectiveWatchPollingIntervalSeconds: 60
    })
    expect(setDevboxProfileWatchPollingInterval(profileRoot, {}, 'p1', undefined)).toEqual({
      profileId: 'p1',
      watchPollingIntervalSeconds: null,
      effectiveWatchPollingIntervalSeconds: 10
    })
  })

  it('rejects zero, fractional, and unsafe interval values', () => {
    const profileRoot = join(mkdtempSync(join(tmpdir(), 'devbox-watch-polling-invalid-')), 'profiles')
    const store = new DevboxProfileStore({ rootDir: profileRoot })
    expect(store.saveProfile(profile).status).toBe('saved')
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => setDevboxProfileWatchPollingInterval(profileRoot, {}, 'p1', value)).toThrow('positive safe integer')
    }
  })
})

describe('profile shell directory preference', () => {
  it('persists and clears a remote shell directory on the profile record', () => {
    const profileRoot = join(mkdtempSync(join(tmpdir(), 'devbox-shell-dir-')), 'profiles')
    const store = new DevboxProfileStore({ rootDir: profileRoot })
    expect(store.saveProfile(profile).status).toBe('saved')
    expect(setDevboxProfileShellDir(profileRoot, {}, 'p1', '/home/sample')).toEqual({ profileId: 'p1', shellDir: '/home/sample' })
    expect(showDevboxProfileShellDir(profileRoot, {}, 'p1')).toEqual({ profileId: 'p1', shellDir: '/home/sample' })
    expect(setDevboxProfileShellDir(profileRoot, {}, 'p1', undefined)).toEqual({ profileId: 'p1', shellDir: null })
    expect(showDevboxProfileShellDir(profileRoot, {}, 'p1')).toEqual({ profileId: 'p1', shellDir: null })
  })
})
