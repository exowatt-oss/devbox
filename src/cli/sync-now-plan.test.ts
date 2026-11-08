import { describe, expect, it } from 'vitest'
import { CliArgumentError } from './args'
import { HOME, MACHINE_KEYS, PASTE_ROOT, PROFILES, REAL_SESSIONS, fixtureProfile, sessionJson } from './__fixtures__/sync-now-fixture'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { profileSshEndpoint } from './profile-ssh'
import { laneKind, planSyncNow, type SyncNowSelection } from './sync-now-plan'
import { parseSyncSessions } from './sync-now-session'

function plan(selection: SyncNowSelection = {}, sessions: Record<string, unknown>[] = REAL_SESSIONS, profiles: DevboxProfileV1[] = PROFILES) {
  return planSyncNow({
    sessions: parseSyncSessions(JSON.stringify(sessions)),
    profiles,
    home: HOME,
    selection,
    endpointFor: (profile) => profileSshEndpoint(profile),
    isLocal: () => false
  })
}

describe('db sync planning', () => {
  it('groups every Devbox-owned session into one machine per ssh endpoint with device aliases', () => {
    const targets = plan()
    expect(targets.map((target) => [target.machine.name, target.machine.key, target.machine.proxied])).toEqual([
      ['aws', MACHINE_KEYS.aws, true],
      ['macmini', MACHINE_KEYS.macmini, false],
      ['workstation', MACHINE_KEYS.workstation, false]
    ])
    const aws = targets[0]!
    expect(aws.profileIds).toEqual(['devbox', 'phi-sessions'])
    expect(aws.proxyCommand).toBe(`${HOME}/.local/bin/devbox proxy`)
    expect(aws.endpoint.extraOptions).toEqual([`ProxyCommand=${HOME}/.local/bin/devbox proxy`, 'HostKeyAlias=devbox'])
    expect(aws.machine).toMatchObject({ user: 'alice', host: 'devbox', port: 22 })
  })

  it('builds lanes by profile and root pair, with kinds, labels, keys, and paused-before state', () => {
    const [aws, macmini, workstation] = plan()
    expect(aws!.machine.lanes).toEqual([
      { key: 'devbox:workspace', kind: 'workspace', label: 'workspace', profileId: 'devbox', localPath: '~/project', remotePath: '/home/alice/project', sessionIds: ['sync_devbox_decl', 'sync_devbox_work'], pausedBefore: ['sync_devbox_decl', 'sync_devbox_work'] },
      { key: 'phi-sessions:phi-sessions', kind: 'phi-sessions', label: 'phi sessions', profileId: 'phi-sessions', localPath: '~/.pi/agent/session-sync', remotePath: '/home/alice/.pi/agent/session-sync', sessionIds: ['sync_phi'], pausedBefore: ['sync_phi'] }
    ])
    expect(workstation!.machine.lanes.map((lane) => [lane.key, lane.kind, lane.label, lane.localPath])).toEqual([
      ['project:workspace', 'workspace', 'project', '~/project'],
      ['roam:workspace', 'workspace', 'roam', '~/scratch/roam'],
      ['roam:credentials', 'credentials', 'credentials', '~/.mcp-auth'],
      ['roam:images', 'images', 'images', PASTE_ROOT]
    ])
    const withTmp = planSyncNow({ sessions: parseSyncSessions(JSON.stringify(REAL_SESSIONS)), profiles: PROFILES, home: HOME, tmpDir: `${PASTE_ROOT}/`, selection: {}, endpointFor: (profile) => profileSshEndpoint(profile), isLocal: () => false })
    expect(withTmp[2]!.machine.lanes.at(-1)!.localPath).toBe('$TMPDIR')
    expect(macmini!.machine.lanes).toHaveLength(1)
    expect(macmini!.machine.lanes[0]).toMatchObject({ sessionIds: ['sync_macmini_decl', 'sync_macmini_work'], pausedBefore: [] })
  })

  it('maps root classes and the phi-sessions profile to lane kinds', () => {
    expect(laneKind('p', 'portable-working')).toBe('workspace')
    expect(laneKind('p', 'portable-declarative')).toBe('workspace')
    expect(laneKind('p', 'paste')).toBe('images')
    expect(laneKind('p', 'credentials')).toBe('credentials')
    expect(laneKind('phi-sessions', undefined)).toBe('phi-sessions')
    expect(laneKind('notes', undefined)).toBe('other')
    const [other] = plan({}, [sessionJson({ id: 's1', profile: 'notes', local: `${HOME}/notes`, user: 'u', host: 'h', remote: '/n' })], [])
    expect(other!.machine.lanes[0]).toMatchObject({ kind: 'other', label: 'notes', key: 'notes:other' })
  })

  it('builds a label-only machine from the beta endpoint when no profile matches (ssh config applies)', () => {
    const sessions = [sessionJson({ id: 'sync_phi', profile: 'phi-sessions', local: `${HOME}/.pi/agent/session-sync`, user: 'alice', host: 'devbox', remote: '/s', port: 2222 })]
    const [target] = plan({}, sessions, [])
    expect(target!.machine).toMatchObject({ key: 'alice@devbox:2222', name: 'devbox', proxied: false, port: 2222 })
    expect(target!.endpoint).toEqual({ host: 'devbox', port: 2222, username: 'alice' })
    expect(target!.proxyCommand).toBeUndefined()
  })

  it('ignores sessions that Devbox does not own or that have no ssh beta', () => {
    const foreign = { ...sessionJson({ id: 'x', profile: 'p', local: '/a', user: 'u', host: 'h', remote: '/b' }), labels: { 'devbox-profile': 'p' } }
    const local = { ...sessionJson({ id: 'y', profile: 'p', local: '/a', user: 'u', host: 'h', remote: '/b' }), beta: { protocol: 'local', path: '/b' } }
    expect(plan({}, [foreign, local])).toEqual([])
  })

  it('disambiguates repeated lane keys across the plan and labels within a machine', () => {
    const sessions = [
      sessionJson({ id: 'c1', profile: 'roam', rootClass: 'credentials', local: `${HOME}/.mcp-auth`, user: 'sample', host: '203.0.113.10', remote: '/r/.mcp-auth' }),
      sessionJson({ id: 'c2', profile: 'roam', rootClass: 'credentials', local: `${HOME}/.config/gh`, user: 'sample', host: '203.0.113.10', remote: '/r/.config/gh' })
    ]
    const lanes = plan({}, sessions)[0]!.machine.lanes
    expect(lanes.map((lane) => [lane.key, lane.label])).toEqual([
      ['roam:credentials', 'credentials (gh)'],
      ['roam:credentials:2', 'credentials (.mcp-auth)']
    ])
  })

  it('narrows by --profile to that profile lanes and by --device to whole machines', () => {
    const roam = plan({ profile: 'roam' })
    expect(roam.map((target) => target.machine.name)).toEqual(['workstation'])
    expect(roam[0]!.machine.lanes.map((lane) => lane.key)).toEqual(['roam:workspace', 'roam:credentials', 'roam:images'])
    expect(roam[0]!.profileIds).toEqual(['roam'])
    expect(plan({ profile: 'phi-sessions' }).map((target) => target.machine.lanes.map((lane) => lane.key))).toEqual([['phi-sessions:phi-sessions']])
    expect(plan({ device: 'aws' }).map((target) => target.machine.lanes.length)).toEqual([2])
    expect(plan({ device: 'devbox' }).map((target) => target.machine.name)).toEqual(['aws'])
    expect(plan({ device: '192.0.2.12' }).map((target) => target.machine.name)).toEqual(['macmini'])
  })

  it('fails unknown --profile / --device values with the known list', () => {
    expect(() => plan({ profile: 'nope' })).toThrow(CliArgumentError)
    expect(() => plan({ profile: 'nope' })).toThrow('Profiles with Mutagen sessions: devbox, macmini, phi-sessions, project, roam.')
    expect(() => plan({ device: 'nope' })).toThrow('Known devices: aws, macmini, workstation.')
  })

  it('names a single unaliased profile machine by its profile id like shell ls', () => {
    const profiles = [fixtureProfile('solo', { user: 'u', host: '192.0.2.11' })]
    const sessions = [sessionJson({ id: 's', profile: 'solo', rootClass: 'portable-working', local: `${HOME}/w`, user: 'u', host: '192.0.2.11', remote: '/w' })]
    expect(plan({}, sessions, profiles)[0]!.machine.name).toBe('solo')
  })
})
