import { describe, expect, it, vi } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxShellListResult } from './shell-sessions'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupDevboxProfilesByDevice, listDevboxShellSessionsEverywhere, type DevboxDeviceGroup } from './shell-devices'
import { createDevboxShellProbeCache } from './shell-probe-cache'

function profile(id: string, host: string, device?: string): DevboxProfileV1 {
  return {
    schemaVersion: 3,
    id,
    displayName: id,
    ...(device === undefined ? {} : { device }),
    sshTarget: { targetId: id, identity: { host, port: 22, username: 'sample', hostKeyFingerprint: 'SHA256:abc' } },
    roots: { localRoot: `/tmp/${id}`, remoteRoot: `/home/sample/${id}` },
    pathMap: [],
    toolchain: { lockId: 'toolchain', lockSha256: 'a'.repeat(64) },
    sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] },
    gitRoaming: { enabled: false, topology: 'working-tree-only', authorityScope: 'profile', parkedGitName: '.git.devbox-parked', refreshStrategy: 'origin', requireCleanHandoff: true, requirePublishedHead: true, excludeWorktrees: true, ignorePatterns: [] },
    credentials: [], defaultAuthority: 'local', projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true }, featureDefaults: { detachedJobs: true, closedSessionHistory: true }, slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
  }
}

function listed(profileId: string, id: number, lastUsed: number): DevboxShellListResult {
  return { profileId, mostRecentId: id, sessions: [{ id, sessionName: `devbox-${profileId}-${id}`, created: lastUsed - 10, attached: false, lastUsed, currentCommand: 'bash', currentTitle: '', mostRecent: true }] }
}

describe('device-aware shell inventory', () => {
  it('groups endpoint-shared profiles and puts the default device first', () => {
    const profiles = [profile('macmini', '192.0.2.12'), profile('project', '203.0.113.10', 'workstation'), profile('roam', '203.0.113.10', 'workstation')]
    const groups = groupDevboxProfilesByDevice(profiles, 'roam')
    expect(groups.map((group) => group.device)).toEqual(['workstation', 'macmini'])
    expect(groups[0]?.profiles.map((item) => item.id)).toEqual(['roam', 'project'])
  })

  it('probes each shared endpoint once, preserving unreachable errors and global recency', async () => {
    const profiles = [profile('roam', 'host-a', 'workstation'), profile('project', 'host-a', 'workstation'), profile('macmini', 'host-b')]
    const groups = groupDevboxProfilesByDevice(profiles, 'roam')
    const probe = vi.fn(async (group: DevboxDeviceGroup) => {
      if (group.host === 'host-b') {throw new Error('connection refused\nextra')}
      return new Map(group.profiles.map((item) => [item.id, item.id === 'roam' ? listed('roam', 2, 200) : { profileId: item.id, mostRecentId: null, sessions: [] }]))
    })
    const result = await listDevboxShellSessionsEverywhere({ groups, defaultProfileId: 'roam', probe })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe.mock.calls.map(([group]) => group.profiles.map((item) => item.id))).toEqual([['roam', 'project'], ['macmini']])
    expect(result.sessionCount).toBe(1)
    expect(result.unreachableCount).toBe(1)
    expect(result.mostRecent).toMatchObject({ profileId: 'roam', device: 'workstation', id: 2 })
    expect(result.devices[0]).toMatchObject({ device: 'workstation', default: true, status: 'ok' })
    expect(result.devices[1]).toMatchObject({ device: 'macmini', status: 'unreachable', error: 'connection refused' })
    expect(result.devices[1]?.profiles[0]).toMatchObject({ profileId: 'macmini', reachable: false, error: 'connection refused' })
  })

  it('probes devices in parallel so the slowest host bounds the wall time', async () => {
    const groups = groupDevboxProfilesByDevice([profile('a', 'host-a'), profile('b', 'host-b'), profile('c', 'host-c')])
    let inFlight = 0
    let peak = 0
    const probe = vi.fn(async (group: DevboxDeviceGroup) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 60))
      inFlight -= 1
      return new Map([[group.profiles[0]!.id, { profileId: group.profiles[0]!.id, mostRecentId: null, sessions: [] }]])
    })
    const started = Date.now()
    const result = await listDevboxShellSessionsEverywhere({ groups, probe })
    expect(peak).toBe(3)
    expect(Date.now() - started).toBeLessThan(170)
    expect(result.elapsedMs).toBeLessThan(170)
    expect(result.devices.every((device) => device.status === 'ok' && device.elapsedMs >= 50)).toBe(true)
  })

  it('skips a recently unreachable host until --refresh, and reports progress per device', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'devbox-shell-ls-')), 'shell-ls-unreachable.json')
    let now = 5_000_000
    const cache = createDevboxShellProbeCache(file, { now: () => now })
    const groups = groupDevboxProfilesByDevice([profile('project', 'dead-host', 'workstation'), profile('macmini', 'live-host')])
    const probe = vi.fn(async (group: DevboxDeviceGroup) => {
      if (group.host === 'dead-host') {throw new Error('connect timed out after 3.0 s')}
      return new Map([['macmini', { profileId: 'macmini', mostRecentId: null, sessions: [] }]])
    })
    await listDevboxShellSessionsEverywhere({ groups, probe, cache, now: () => now })
    expect(probe).toHaveBeenCalledTimes(2)
    now += 12_000
    const events: string[] = []
    const second = await listDevboxShellSessionsEverywhere({ groups, probe, cache, now: () => now, onProgress: (event) => {
      events.push(event.type === 'done' ? `done:${event.device.device}:${event.device.status}` : event.type === 'plan' ? 'plan' : `${event.type}:${event.group.device}`)
    } })
    expect(probe).toHaveBeenCalledTimes(3)
    expect(second.devices[1]).toMatchObject({ device: 'workstation', status: 'skipped', elapsedMs: 0, error: 'skipped: unreachable 12 s ago, --refresh to retry', unreachableAt: 5_000_000 })
    expect(events[0]).toBe('plan')
    expect(events.toSorted()).toEqual(['done:macmini:ok', 'done:workstation:skipped', 'plan', 'start:macmini'])
    await listDevboxShellSessionsEverywhere({ groups, probe, cache, now: () => now, refresh: true })
    expect(probe).toHaveBeenCalledTimes(5)
  })

  it('keeps the shell ls JSON shape backward compatible and only adds fields', async () => {
    const groups = groupDevboxProfilesByDevice([profile('roam', 'host-a', 'workstation')], 'roam')
    const result = await listDevboxShellSessionsEverywhere({ groups, defaultProfileId: 'roam', probe: async () => new Map([['roam', listed('roam', 1, 100)]]) })
    expect(Object.keys(result).toSorted()).toEqual(['defaultProfileId', 'devices', 'elapsedMs', 'mostRecent', 'scope', 'sessionCount', 'unreachableCount'])
    expect(Object.keys(result.devices[0]!).toSorted()).toEqual(['default', 'device', 'elapsedMs', 'host', 'port', 'profiles', 'status', 'username'])
    expect(Object.keys(result.devices[0]!.profiles[0]!).toSorted()).toEqual(['default', 'device', 'mostRecentId', 'profileId', 'reachable', 'sessions'])
  })
})
