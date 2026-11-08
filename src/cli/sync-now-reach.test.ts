import { describe, expect, it, vi } from 'vitest'
import { DEVBOXES_CLI, HOME, PROFILES, REAL_SESSIONS } from './__fixtures__/sync-now-fixture'
import type { ServiceExec } from './mutagen-service'
import { profileSshEndpoint } from './profile-ssh'
import { planSyncNow, type SyncNowTarget } from './sync-now-plan'
import { createSyncReach, proxyPowerCliOf, proxyPowerState, SYNC_DIRECT_BUDGET, SYNC_PROXIED_BUDGET, SYNC_WAKE_BUDGET, type SyncProbe } from './sync-now-reach'
import { parseSyncSessions } from './sync-now-session'

const targets = planSyncNow({
  sessions: parseSyncSessions(JSON.stringify(REAL_SESSIONS)),
  profiles: PROFILES,
  home: HOME,
  selection: {},
  endpointFor: (profile) => profileSshEndpoint(profile),
  isLocal: () => false
})
const byName = (name: string): SyncNowTarget => targets.find((target) => target.machine.name === name)!
const labelOnly: SyncNowTarget = { ...byName('aws'), proxyCommand: undefined, endpoint: { host: 'devbox', port: 22, username: 'alice' } }

function setup(state: string | 'fail', sshConfigProxy = 'none') {
  const calls: string[] = []
  const exec: ServiceExec = async (command, args) => {
    calls.push([command, ...args].join(' '))
    if (command === 'ssh') {return { exitCode: 0, stdout: `user alice\nproxycommand ${sshConfigProxy}\n`, stderr: '' }}
    return state === 'fail'
      ? { exitCode: 1, stdout: '', stderr: 'devbox: not logged in\nrun devbox key' }
      : { exitCode: 0, stdout: `state: ${state}\nip: 1.2.3.4\n`, stderr: '' }
  }
  const probe = vi.fn<SyncProbe>(async () => undefined)
  const waking: string[] = []
  const options = (wake = false) => ({ wake, signal: new AbortController().signal, onWaking: (detail: string) => waking.push(detail) })
  return { calls, probe, waking, options, reach: createSyncReach({ exec, home: HOME, powerCli: 'devbox', probe }) }
}

describe('db sync reachability', () => {
  it('recognises only the configured power provider as a proxy command', () => {
    expect(proxyPowerCliOf(`${DEVBOXES_CLI} proxy`, HOME, 'devbox')).toBe(DEVBOXES_CLI)
    expect(proxyPowerCliOf('$HOME/.local/bin/devbox proxy', HOME, 'devbox')).toBe(DEVBOXES_CLI)
    expect(proxyPowerCliOf('~/.local/bin/devbox proxy', HOME, 'devbox')).toBe(DEVBOXES_CLI)
    expect(proxyPowerCliOf('devbox proxy', HOME, 'devbox')).toBe('devbox')
    expect(proxyPowerCliOf('/usr/bin/nc %h %p', HOME, 'devbox')).toBeUndefined()
    expect(proxyPowerCliOf(`${DEVBOXES_CLI} status`, HOME, 'devbox')).toBeUndefined()
    expect(proxyPowerCliOf(`${DEVBOXES_CLI} proxy`, HOME, 'other')).toBeUndefined()
  })

  it('does not invoke any power provider unless configured', async () => {
    const calls: string[] = []
    const exec: ServiceExec = async (command, args) => {
      calls.push([command, ...args].join(' '))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const probe = vi.fn<SyncProbe>(async () => undefined)
    const reach = createSyncReach({ exec, home: HOME, probe })
    expect(await reach(byName('aws'), { wake: false, signal: new AbortController().signal, onWaking: () => undefined })).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0]![1]).toEqual(SYNC_PROXIED_BUDGET)
  })

  it('probes a direct host with the tight budget (after checking ssh config for a proxy)', async () => {
    const { reach, probe, options, calls } = setup('running')
    expect(await reach(byName('macmini'), options())).toEqual({ ok: true })
    expect(probe.mock.calls[0]![1]).toEqual(SYNC_DIRECT_BUDGET)
    expect(calls).toEqual(['ssh -G -p 22 exampleuser@192.0.2.12'])
  })

  it('probes a running host through a configured power provider', async () => {
    const { reach, probe, options, calls } = setup('running')
    expect(await reach(byName('aws'), options())).toEqual({ ok: true })
    expect(calls).toEqual([`${DEVBOXES_CLI} status`])
    expect(probe.mock.calls[0]![1]).toEqual(SYNC_PROXIED_BUDGET)
  })

  it('skips a stopped host without probing unless --wake', async () => {
    const { reach, probe, options, waking } = setup('stopped')
    expect(await reach(byName('aws'), options())).toEqual({ ok: false, reason: 'stopped', detail: 'stopped (db sync --wake allows probing)' })
    expect(probe).not.toHaveBeenCalled()
    expect(await reach(byName('aws'), options(true))).toEqual({ ok: true })
    expect(waking).toEqual(['probing the stopped host'])
    expect(probe.mock.calls[0]![1]).toEqual(SYNC_WAKE_BUDGET)
  })

  it('never probes when devbox status cannot tell whether the box runs', async () => {
    const { reach, probe, options } = setup('fail')
    const result = await reach(byName('aws'), options())
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(result.ok ? '' : result.detail).toBe('power provider status failed (devbox: not logged in); not probing so a stopped host is not woken (db sync --wake)')
    expect(probe).not.toHaveBeenCalled()
  })

  it('gates a label-only machine whose ~/.ssh/config routes through `devbox proxy`', async () => {
    const { reach, probe, options, calls } = setup('stopped', `${DEVBOXES_CLI} proxy`)
    expect(await reach(labelOnly, options())).toMatchObject({ ok: false, reason: 'stopped' })
    expect(calls).toEqual(['ssh -G -p 22 alice@devbox', `${DEVBOXES_CLI} status`])
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports a failed probe as unreachable with its one-line reason', async () => {
    const { options } = setup('running')
    const reach = createSyncReach({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }), home: HOME, probe: async () => { throw new Error('no answer within 6.0 s\nmore') } })
    expect(await reach(byName('workstation'), options())).toEqual({ ok: false, reason: 'unreachable', detail: 'no answer within 6.0 s' })
  })

  it('parses `devbox status` output', async () => {
    const exec: ServiceExec = async () => ({ exitCode: 0, stdout: 'state: pending\n', stderr: '' })
    expect(await proxyPowerState(exec, DEVBOXES_CLI)).toEqual({ state: 'pending', detail: 'state: pending' })
  })
})
