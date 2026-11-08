import { describe, expect, it } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import {
  clipboardPasteRoot,
  disableDevboxPasteSync,
  enableDevboxPasteSync,
  normalizeDevboxPasteSyncConfig,
  normalizePasteRootPath,
  pasteSyncExcludes,
  validateDevboxPasteSyncConfig,
  validPastePattern
} from './devbox-paste-sync'
import { devboxPasteSyncRequests } from './devbox-paste-sync-requests'

const profile: DevboxProfileV1 = {
  schemaVersion: 3,
  id: 'p1',
  displayName: 'p1',
  sshTarget: {
    targetId: 't1',
    identity: { host: 'host', port: 22, username: 'sample', hostKeyFingerprint: 'SHA256:abc123' }
  },
  roots: { localRoot: '/local', remoteRoot: '/remote' },
  pathMap: [],
  toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }],
    defaultClassId: 'working',
    excludes: []
  },
  gitRoaming: undefined,
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
}

const macTemp = '/tmp/devbox-paste/'

describe('paste sync roots', () => {
  it('mirrors the trimmed temp directory to the same absolute path by default', () => {
    expect(clipboardPasteRoot(macTemp)).toEqual({
      id: 'clipboard',
      localRoot: '/tmp/devbox-paste',
      remoteRoot: '/tmp/devbox-paste',
      patterns: ['terminal-paste-*']
    })
    expect(clipboardPasteRoot('/tmp', '/home/sample/paste/', ['remote-paste-*', 'terminal-paste-*'])).toEqual({
      id: 'clipboard',
      localRoot: '/tmp',
      remoteRoot: '/home/sample/paste',
      patterns: ['terminal-paste-*', 'remote-paste-*']
    })
    expect(normalizePasteRootPath('/')).toBe('/')
    expect(normalizePasteRootPath('/a/b///')).toBe('/a/b')
  })

  it('accepts plain root-level file globs only', () => {
    for (const ok of ['terminal-paste-*', 'terminal-paste-*.png', 'shot-?.png', 'exact.png']) {
      expect(validPastePattern(ok)).toBe(true)
    }
    for (const bad of ['', ' ', '*', '**', '.', '..', 'a/b', 'a\\b', '!x', '#x', 'a\u0000b', 7]) {
      expect(validPastePattern(bad)).toBe(false)
    }
  })

  it('validates and normalizes persisted configs', () => {
    expect(validateDevboxPasteSyncConfig({ enabled: false, roots: [] })).toBe(true)
    expect(validateDevboxPasteSyncConfig({ enabled: true, roots: [clipboardPasteRoot(macTemp)] })).toBe(true)
    expect(validateDevboxPasteSyncConfig({ enabled: true, roots: [clipboardPasteRoot(macTemp), clipboardPasteRoot('/tmp')] })).toBe(false)
    expect(validateDevboxPasteSyncConfig({ enabled: true, roots: [{ ...clipboardPasteRoot(macTemp), patterns: [] }] })).toBe(false)
    expect(validateDevboxPasteSyncConfig({ enabled: true, roots: [{ ...clipboardPasteRoot(macTemp), remoteRoot: 'relative' }] })).toBe(false)
    expect(validateDevboxPasteSyncConfig({ enabled: 'yes', roots: [] })).toBe(false)
    expect(normalizeDevboxPasteSyncConfig({
      enabled: true,
      roots: [
        { id: 'zz', localRoot: '/a', remoteRoot: '/a', patterns: ['x*', 'x*'] },
        { id: 'aa', localRoot: '/b', remoteRoot: '/b', patterns: ['y*'] }
      ]
    })).toEqual({
      enabled: true,
      roots: [
        { id: 'aa', localRoot: '/b', remoteRoot: '/b', patterns: ['y*'] },
        { id: 'zz', localRoot: '/a', remoteRoot: '/a', patterns: ['x*'] }
      ]
    })
  })

  it('enables by replacing a same-id root, disables while keeping roots', () => {
    const enabled = enableDevboxPasteSync(profile, clipboardPasteRoot(macTemp))
    expect(enabled.pasteSync).toEqual({ enabled: true, roots: [clipboardPasteRoot(macTemp)] })
    const replaced = enableDevboxPasteSync(enabled, clipboardPasteRoot('/tmp'))
    expect(replaced.pasteSync?.roots).toEqual([clipboardPasteRoot('/tmp')])
    const disabled = disableDevboxPasteSync(replaced)
    expect(disabled.pasteSync).toEqual({ enabled: false, roots: [clipboardPasteRoot('/tmp')] })
    expect(disableDevboxPasteSync(profile).pasteSync).toEqual({ enabled: false, roots: [] })
  })

  it('rejects invalid roots at enable time with a recovery field', () => {
    expect(() => enableDevboxPasteSync(profile, { ...clipboardPasteRoot(macTemp), id: 'Bad Id' }))
      .toThrowError(expect.objectContaining({ code: 'operation_conflict', context: { field: 'paste-root-id' } }))
    expect(() => enableDevboxPasteSync(profile, { ...clipboardPasteRoot(macTemp), localRoot: 'relative' }))
      .toThrowError(expect.objectContaining({ context: { field: 'paste-root-absolute-paths' } }))
    expect(() => enableDevboxPasteSync(profile, { ...clipboardPasteRoot(macTemp), patterns: ['a/b'] }))
      .toThrowError(expect.objectContaining({ context: { field: 'paste-root-pattern' } }))
  })

  it('renders ignore-all plus negations and builds one one-way request per root', () => {
    const root = clipboardPasteRoot(macTemp, undefined, ['remote-paste-*'])
    expect(pasteSyncExcludes(root)).toEqual(['*', '!terminal-paste-*', '!remote-paste-*'])
    expect(devboxPasteSyncRequests(profile)).toEqual([])
    expect(devboxPasteSyncRequests(disableDevboxPasteSync(enableDevboxPasteSync(profile, root)))).toEqual([])
    expect(devboxPasteSyncRequests(enableDevboxPasteSync(profile, root))).toEqual([{
      profileId: 'p1',
      sessionId: 'p1-paste-clipboard',
      rootClassId: 'paste',
      localRoot: root.localRoot,
      remoteRoot: root.remoteRoot,
      mode: 'one-way-replica',
      exclusionPolicy: 'explicit-only',
      maxEntryCount: 50_000,
      excludes: ['*', '!terminal-paste-*', '!remote-paste-*']
    }])
  })
})
