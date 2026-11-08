import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { CliArgumentError, parseArgs, validateCommandAndFlags } from './args'
import { clearDevboxDefaultDevice, listDevboxDevices, setDevboxDefaultDevice, showDevboxDefaultDevice, type DevboxDeviceService } from './device-command'
import { main } from './index'
import { DevboxService } from './operations'
import { listDevboxProfiles, useDevboxProfile } from './profile-preferences'
import { resolveCommandProfile } from './profile-scope'
import { COMMAND_SPECS } from './specs'

function makeProfile(id: string, host: string, device?: string): DevboxProfileV1 {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    ...(device === undefined ? {} : { device }),
    sshTarget: { targetId: `t-${id}`, identity: { host, port: 22, username: 'alice', hostKeyFingerprint: 'SHA256:abc123' } },
    roots: { localRoot: `/local/${id}`, remoteRoot: `/remote/${id}` },
    pathMap: [{ id: 'workspace', localRelativePath: '.', remoteRelativePath: '.', syncClassId: 'working' }],
    toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
    sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] },
    credentials: [], defaultAuthority: 'remote',
    projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
    featureDefaults: { detachedJobs: true, closedSessionHistory: true },
    slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
  }
}

/** A state root holding the real profile store + config the CLI uses, with the real profile operations. */
function makeState(): { stateRoot: string; service: DevboxDeviceService } {
  const stateRoot = mkdtempSync(join(tmpdir(), 'devbox-device-default-'))
  const profileRoot = join(stateRoot, 'profiles')
  const store = new DevboxProfileStore({ rootDir: profileRoot, env: {} })
  for (const profile of [makeProfile('devbox', 'devbox', 'aws'), makeProfile('project', '203.0.113.10', 'workstation'), makeProfile('macmini', '192.0.2.12')]) {
    expect(store.saveProfile(profile).status).toBe('saved')
  }
  return {
    stateRoot,
    service: {
      listProfiles: () => listDevboxProfiles(profileRoot, stateRoot, {}),
      useProfile: (id) => useDevboxProfile(profileRoot, stateRoot, {}, id)
    }
  }
}

function configuredDefault(stateRoot: string): unknown {
  return (JSON.parse(readFileSync(join(stateRoot, 'config.json'), 'utf8')) as { defaultProfile?: string }).defaultProfile
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('devbox device --default', () => {
  it('resolves a device alias to its profile and stores it exactly like profile use', () => {
    const { stateRoot, service } = makeState()
    expect(setDevboxDefaultDevice(service, 'aws', {})).toEqual({
      action: 'set', defaultProfile: 'devbox', device: 'aws', username: 'alice', host: 'devbox', port: 22
    })
    expect(configuredDefault(stateRoot)).toBe('devbox')
  })

  it('accepts a profile id when no alias matches (and for profiles without an alias)', () => {
    const { stateRoot, service } = makeState()
    expect(setDevboxDefaultDevice(service, 'project', {})).toMatchObject({ defaultProfile: 'project', device: 'workstation' })
    expect(setDevboxDefaultDevice(service, 'macmini', {})).toMatchObject({ defaultProfile: 'macmini', device: null, host: '192.0.2.12' })
    expect(configuredDefault(stateRoot)).toBe('macmini')
  })

  it('rejects an unknown alias, lists the known devices, and leaves the default untouched', () => {
    const { stateRoot, service } = makeState()
    setDevboxDefaultDevice(service, 'aws', {})
    const failure = (() => {
      try {
        setDevboxDefaultDevice(service, 'nope', {})
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(failure).toBeInstanceOf(CliArgumentError)
    expect((failure as Error).message).toContain('Unknown device "nope"')
    expect((failure as Error).message).toContain('aws (profile devbox), macmini (no alias), workstation (profile project)')
    expect(configuredDefault(stateRoot)).toBe('devbox')
  })

  it('shows and clears the default device', () => {
    const { stateRoot, service } = makeState()
    expect(showDevboxDefaultDevice(service, {})).toEqual({ action: 'show', defaultProfile: null, device: null })
    setDevboxDefaultDevice(service, 'workstation', {})
    expect(showDevboxDefaultDevice(service, { DEVBOX_PROFILE: 'macmini' })).toEqual({
      action: 'show', defaultProfile: 'project', device: 'workstation', username: 'alice', host: '203.0.113.10', port: 22, environmentOverride: 'macmini'
    })
    expect(clearDevboxDefaultDevice(service, {})).toEqual({ action: 'clear', defaultProfile: null, device: null })
    expect(configuredDefault(stateRoot)).toBeUndefined()
    expect(showDevboxDefaultDevice(service, {}).defaultProfile).toBeNull()
  })

  it('lists devices with the default marked, mirroring profile list', () => {
    const { service } = makeState()
    setDevboxDefaultDevice(service, 'aws', {})
    expect(listDevboxDevices(service)).toEqual({
      defaultProfile: 'devbox',
      defaultDevice: 'aws',
      devices: [
        { device: 'aws', profileId: 'devbox', username: 'alice', host: 'devbox', port: 22, default: true },
        { device: null, profileId: 'macmini', username: 'alice', host: '192.0.2.12', port: 22, default: false },
        { device: 'workstation', profileId: 'project', username: 'alice', host: '203.0.113.10', port: 22, default: false }
      ]
    })
  })

  it('routes a following command with no --profile/--device flag to the new default', () => {
    const { stateRoot, service } = makeState()
    const env = { DEVBOX_STATE_ROOT: stateRoot }
    // Like `shell ls`, `shell reconnect --all` needs no profile: it covers every device.
    expect(resolveCommandProfile(['shell'], new Map([['all', true]]), env, ['reconnect'])).toBeUndefined()
    expect(() => resolveCommandProfile(['shell'], new Map(), env, ['resume'])).toThrow()
    setDevboxDefaultDevice(service, 'workstation', {})
    expect(resolveCommandProfile(['run'], new Map(), env)).toMatchObject({ profileId: 'project', source: 'configured' })
    expect(resolveCommandProfile(['shell'], new Map(), env, ['new', 'agents'])).toMatchObject({ profileId: 'project', source: 'configured' })
    setDevboxDefaultDevice(service, 'aws', {})
    expect(resolveCommandProfile(['mutagen', 'status'], new Map(), env)).toMatchObject({ profileId: 'devbox', source: 'configured' })
    // `sync` spans every machine: the default never narrows it, nor do --profile/--device resolve a single profile.
    expect(resolveCommandProfile(['sync'], new Map(), env)).toBeUndefined()
    expect(resolveCommandProfile(['sync'], new Map([['device', 'workstation']]), env)).toBeUndefined()
  })
})

describe('devbox device CLI surface', () => {
  it('parses --default with and without a value and --clear-default', () => {
    for (const argv of [['device', '--default', 'aws'], ['device', '--default'], ['device', '--clear-default'], ['device'], ['device', 'ls'], ['device', 'default']]) {
      expect(() => validateCommandAndFlags(COMMAND_SPECS, parseArgs(argv))).not.toThrow()
    }
    expect(parseArgs(['device', '--default', 'aws']).flags.get('default')).toBe('aws')
    expect(parseArgs(['device', '--default', '--json']).flags.get('default')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parseArgs(['device', 'ls', '--default', 'aws']))).toThrow(/Unknown flag --default/u)
  })

  it('sets the default through main() without resolving a profile first, and keeps profile use working', async () => {
    const { stateRoot } = makeState()
    vi.stubEnv('DEVBOX_STATE_ROOT', stateRoot)
    vi.stubEnv('DEVBOX_PROFILE', '')
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
    const makeService = (): DevboxService => new DevboxService({ stateRoot })
    await main(['device', '--default', 'aws', '--json'], '/tmp', makeService, { exitGuard: () => undefined })
    const envelope = JSON.parse(lines.at(-1)!) as { command: string; ok: boolean; result: { defaultProfile: string; device: string } }
    expect(envelope).toMatchObject({ command: 'device default', ok: true, result: { defaultProfile: 'devbox', device: 'aws', host: 'devbox' } })
    await main(['profile', 'use', 'macmini', '--json'], '/tmp', makeService, { exitGuard: () => undefined })
    expect(configuredDefault(stateRoot)).toBe('macmini')
    await main(['device', '--json'], '/tmp', makeService, { exitGuard: () => undefined })
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ command: 'device ls', result: { defaultProfile: 'macmini' } })
    vi.unstubAllEnvs()
  })
})
