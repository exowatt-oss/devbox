import { describe, expect, it } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxShellListResult } from './shell-sessions'
import { locateDevboxShellTarget } from './shell-locate'

function profile(id: string, host: string, device?: string): DevboxProfileV1 {
  return { schemaVersion: 3, id, displayName: id, ...(device === undefined ? {} : { device }), sshTarget: { targetId: id, identity: { host, port: 22, username: 'u', hostKeyFingerprint: 'SHA256:abc' } }, roots: { localRoot: `/tmp/${id}`, remoteRoot: `/remote/${id}` }, pathMap: [], toolchain: { lockId: 'x', lockSha256: 'a'.repeat(64) }, sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] }, gitRoaming: { enabled: false, topology: 'working-tree-only', authorityScope: 'profile', parkedGitName: '.git.devbox-parked', refreshStrategy: 'origin', requireCleanHandoff: true, requirePublishedHead: true, excludeWorktrees: true, ignorePatterns: [] }, credentials: [], defaultAuthority: 'local', projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true }, featureDefaults: { detachedJobs: true, closedSessionHistory: true }, slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' } }
}

function sessions(profileId: string, rows: [number, string?][]): DevboxShellListResult {
  return { profileId, mostRecentId: rows[0]?.[0] ?? null, sessions: rows.map(([id, name]) => ({ id, ...(name === undefined ? {} : { name }), sessionName: `devbox-${profileId}-${id}${name === undefined ? '' : `-${name}`}`, created: 1, attached: false, lastUsed: 1, currentCommand: 'bash', currentTitle: '', mostRecent: false })) }
}

describe('cross-device shell target lookup', () => {
  it('returns a note for a unique match on another device', async () => {
    const profiles = [profile('roam', 'hub-a', 'workstation'), profile('macmini', 'hub-b')]
    const result = await locateDevboxShellTarget({ target: 'macmini', preferredProfileId: 'roam', profiles, list: async (id) => id === 'macmini' ? sessions(id, [[1, 'macmini']]) : sessions(id, []) })
    expect(result).toEqual({ profileId: 'macmini', device: 'macmini', note: "devbox: shell 'macmini' is on device macmini (profile macmini)" })
  })

  it('rejects ambiguous names with --device guidance', async () => {
    const profiles = [profile('roam', 'hub-a', 'workstation'), profile('macmini', 'hub-b'), profile('other', 'hub-c')]
    await expect(locateDevboxShellTarget({ target: 'same', preferredProfileId: 'roam', profiles, list: async (id) => id === 'roam' ? sessions(id, []) : sessions(id, [[1, 'same']]) })).rejects.toThrow('--device')
  })

  it('keeps numeric lookup scoped to the preferred profile when it has sessions', async () => {
    const profiles = [profile('roam', 'hub-a', 'workstation'), profile('macmini', 'hub-b')]
    const calls: string[] = []
    const result = await locateDevboxShellTarget({ target: '1', preferredProfileId: 'roam', profiles, list: async (id) => { calls.push(id); return sessions(id, [[1]]) } })
    expect(result.profileId).toBe('roam')
    expect(calls).toEqual(['roam'])
  })
})
