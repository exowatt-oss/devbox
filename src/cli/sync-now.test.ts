import { describe, expect, it, vi } from 'vitest'
import { CliArgumentError } from './args'
import { DEVBOXES_CLI, HOME, MACHINE_KEYS, PROFILES, REAL_SESSIONS } from './__fixtures__/sync-now-fixture'
import { FakeMutagen } from './__fixtures__/sync-now-fake-mutagen'
import type { ServiceExec } from './mutagen-service'
import { profileSshEndpoint } from './profile-ssh'
import { createPauseTracker, createSyncPoller, runSyncNow, type SyncNowDeps, type SyncNowOptions } from './sync-now'
import type { SyncHooks } from './sync-now-hooks'
import { SyncMutagenError } from './sync-now-mutagen'
import { createSyncReach, SYNC_WAKE_BUDGET, type SyncReach, type SyncReachResult } from './sync-now-reach'
import type { SyncMachineOutcome, SyncNowEvent, SyncNowResult } from './sync-now-types'

const WORKSTATION = ['sync_project_decl', 'sync_project_work', 'sync_roam_decl', 'sync_roam_work', 'sync_roam_creds', 'sync_roam_paste']
const AWS = ['sync_devbox_decl', 'sync_devbox_work', 'sync_phi']
const MACMINI = ['sync_macmini_decl', 'sync_macmini_work']
const ids = (list: readonly string[]): string => list.join(',')

const noHooks: SyncHooks = { find: () => undefined, run: async () => undefined }

function harness(overrides: Partial<SyncNowDeps> & { reachable?: Record<string, SyncReachResult> } = {}) {
  const mutagen = new FakeMutagen(REAL_SESSIONS)
  const events: SyncNowEvent[] = []
  const release = vi.fn()
  const reach: SyncReach = async (target) => overrides.reachable?.[target.machine.name] ?? { ok: true }
  const deps: SyncNowDeps = {
    mutagen,
    profiles: () => PROFILES,
    endpointFor: (profile) => profileSshEndpoint(profile),
    isLocal: () => false,
    home: HOME,
    reach,
    hooks: noHooks,
    acquireLock: async () => ({ release }),
    startDaemon: vi.fn(async () => undefined),
    ...overrides
  }
  const run = (options: Partial<SyncNowOptions> = {}, signal?: AbortSignal): Promise<SyncNowResult> => runSyncNow(
    { selection: {}, wake: false, timeoutMs: 0, stallGraceMs: 40, pollIntervalMs: 2, ...options },
    deps,
    (event) => {
      events.push(event)
      if (event.type === 'machine-done') {mutagen.log.push(`done:${event.outcome.machineKey}:${event.outcome.state}`)}
    },
    signal
  )
  return { mutagen, events, release, deps, run }
}

function outcome(result: SyncNowResult, key: string): SyncMachineOutcome {
  return result.machines.find((machine) => machine.machineKey === key)!
}

describe('db sync engine', () => {
  it('syncs every machine, resumes only the paused sessions, and ends with every session paused (running ones too)', async () => {
    const { mutagen, events, release, run } = harness()
    const result = await run()
    expect(result).toMatchObject({ ok: true, syncedCount: 3, skippedCount: 0, failedCount: 0, interrupted: false })
    expect(mutagen.log).toEqual(expect.arrayContaining([`resume:${ids(WORKSTATION)}`, `resume:${ids(AWS)}`, `flush:${ids(WORKSTATION)}`, `flush:${ids(AWS)}`, `flush:${ids(MACMINI)}`, `pause:${ids(WORKSTATION)}`, `pause:${ids(AWS)}`]))
    expect(mutagen.log.filter((entry) => entry.startsWith('flush:'))).toHaveLength(3)
    // The Mac mini's sessions were found running (a lost pause): never resumed, but paused at the end.
    expect(mutagen.log.some((entry) => entry.startsWith('resume:') && entry.includes('sync_macmini'))).toBe(false)
    expect(mutagen.log).toContain(`pause:${ids(MACMINI)}`)
    expect([...WORKSTATION, ...AWS, ...MACMINI].every((id) => mutagen.paused(id))).toBe(true)
    expect(events[0]!.type).toBe('plan')
    expect(events.at(-1)).toEqual({ type: 'finished', result })
    expect(events.some((event) => event.type === 'lane-progress' && event.laneKey === 'roam:images')).toBe(true)
    expect(outcome(result, MACHINE_KEYS.workstation).lanes.map((lane) => [lane.laneKey, lane.state, lane.files])).toEqual([
      // Two sessions mirror each workspace root: the lane counts its files once.
      ['project:workspace', 'synced', 10], ['roam:workspace', 'synced', 10], ['roam:credentials', 'synced', 10], ['roam:images', 'synced', 10]
    ])
    expect(release).toHaveBeenCalledOnce()
  })

  it('skips a stopped proxy-powered host without --wake and never resumes or probes it', async () => {
    const probe = vi.fn(async () => undefined)
    const exec: ServiceExec = async (command, args) => {
      if (command === DEVBOXES_CLI && args[0] === 'status') {return { exitCode: 0, stdout: 'state: stopped\nip: \n', stderr: '' }}
      return { exitCode: 0, stdout: 'proxycommand none\n', stderr: '' }
    }
    const { mutagen, run } = harness({ reach: createSyncReach({ exec, home: HOME, powerCli: 'devbox', probe }) })
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.aws)).toMatchObject({ state: 'skipped', reason: 'stopped', detail: 'stopped (db sync --wake allows probing)' })
    expect(result).toMatchObject({ ok: true, syncedCount: 2, skippedCount: 1 })
    expect(mutagen.log.some((entry) => /sync_devbox|sync_phi/u.test(entry))).toBe(false)
    expect(probe.mock.calls.map((call) => (call as unknown[])[0] as { machine: { name: string } }).map((target) => target.machine.name).toSorted()).toEqual(['macmini', 'workstation'])
  })

  it('probes a stopped proxy-powered host with --wake and the wake budget', async () => {
    const probe = vi.fn(async () => undefined)
    const exec: ServiceExec = async (command) => command === DEVBOXES_CLI
      ? { exitCode: 0, stdout: 'state: stopped\n', stderr: '' }
      : { exitCode: 0, stdout: 'proxycommand none\n', stderr: '' }
    const { mutagen, events, run } = harness({ reach: createSyncReach({ exec, home: HOME, powerCli: 'devbox', probe }) })
    const result = await run({ wake: true })
    expect(outcome(result, MACHINE_KEYS.aws).state).toBe('synced')
    expect(events).toContainEqual({ type: 'machine-phase', machineKey: MACHINE_KEYS.aws, phase: 'waking', detail: 'probing the stopped host' })
    const awsProbe = probe.mock.calls.find((call) => ((call as unknown[])[0] as { machine: { name: string } }).machine.name === 'aws') as unknown[]
    expect(awsProbe[1]).toEqual(SYNC_WAKE_BUDGET)
    expect(mutagen.log).toContain(`resume:${ids(AWS)}`)
  })

  it('skips an unreachable machine while the others sync, and nothing fails', async () => {
    const { mutagen, run } = harness({ reachable: { workstation: { ok: false, reason: 'unreachable', detail: 'no answer within 6.0 s' } } })
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'skipped', reason: 'unreachable', detail: 'no answer within 6.0 s' })
    expect(result).toMatchObject({ ok: true, syncedCount: 2, skippedCount: 1, failedCount: 0 })
    expect(mutagen.log.some((entry) => entry.includes('sync_project'))).toBe(false)
  })

  it('skips a machine that never connects after resume without flushing it, re-pausing first', async () => {
    const { mutagen, run } = harness()
    mutagen.resumedState = (id) => WORKSTATION.includes(id) ? { status: 'connecting-beta', connected: false } : { status: 'watching', connected: true }
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'skipped', reason: 'stalled' })
    expect(outcome(result, MACHINE_KEYS.workstation).detail).toMatch(/^no connection for \d+ m?s$/u)
    expect(mutagen.log).not.toContain(`flush:${ids(WORKSTATION)}`)
    const pause = mutagen.log.indexOf(`pause:${ids(WORKSTATION)}`)
    expect(pause).toBeGreaterThan(-1)
    expect(mutagen.log.indexOf(`done:${MACHINE_KEYS.workstation}:skipped`)).toBeGreaterThan(pause)
    expect(result.syncedCount).toBe(2)
  })

  it('skips a machine that drops its connection mid-flush past the stall grace and kills the flush', async () => {
    const { mutagen, run } = harness()
    mutagen.flushBehaviour = (flushed) => flushed.includes('sync_project_decl') ? 'hang' : { ok: true }
    mutagen.onList = (fake) => {
      if (fake.log.includes(`flush:${ids(WORKSTATION)}`) && !fake.paused('sync_roam_creds')) {fake.set('sync_roam_creds', { status: 'connecting-beta', connected: false })}
    }
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'skipped', reason: 'stalled' })
    const kill = mutagen.log.indexOf(`kill:${ids(WORKSTATION)}`)
    expect(kill).toBeGreaterThan(mutagen.log.indexOf(`flush:${ids(WORKSTATION)}`))
    expect(mutagen.log.indexOf(`pause:${ids(WORKSTATION)}`)).toBeGreaterThan(kill)
    expect(WORKSTATION.every((id) => mutagen.paused(id))).toBe(true)
  })

  it('does not stall a machine on a session that already finished its flush and then dropped', async () => {
    const { mutagen, run } = harness()
    mutagen.flushDelayFor = (id) => id === 'sync_phi' ? 5 : 200
    mutagen.onList = (fake) => {
      if (fake.sessions.get('sync_phi')?.successfulCycles === 1) {fake.set('sync_phi', { status: 'connecting-beta', connected: false })}
    }
    const result = await run({ stallGraceMs: 30 })
    expect(outcome(result, MACHINE_KEYS.aws).state).toBe('synced')
  })

  it('waits for a running-but-disconnected session to reconnect before flushing it, then pauses it', async () => {
    const { mutagen, run } = harness()
    for (const id of MACMINI) {mutagen.set(id, { status: 'disconnected', connected: false })}
    let polls = 0
    mutagen.onList = (fake) => {
      polls += 1
      if (polls === 4) {for (const id of MACMINI) {fake.set(id, { status: 'watching', connected: true })}}
    }
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.macmini).state).toBe('synced')
    expect(mutagen.log).toContain(`flush:${ids(MACMINI)}`)
    expect(mutagen.log.filter((entry) => entry.includes('sync_macmini'))).toEqual([`flush:${ids(MACMINI)}`, `pause:${ids(MACMINI)}`])
  })

  it('does not treat a connected machine that keeps scanning as hung', async () => {
    const { mutagen, run } = harness()
    mutagen.resumedState = () => ({ status: 'scanning', connected: true })
    mutagen.flushBehaviour = () => ({ ok: true, delayMs: 150 })
    const result = await run({ stallGraceMs: 30 })
    expect(result.syncedCount).toBe(3)
  })

  it('skips a machine over the --timeout cap and re-pauses it', async () => {
    const { mutagen, run } = harness()
    mutagen.resumedState = () => ({ status: 'scanning', connected: true })
    mutagen.flushBehaviour = (flushed) => flushed.includes('sync_project_decl') ? 'hang' : { ok: true }
    const result = await run({ timeoutMs: 300 })
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'skipped', reason: 'timeout' })
    expect(outcome(result, MACHINE_KEYS.workstation).detail).toBe('still syncing at the 300 ms --timeout cap')
    expect(mutagen.log).toContain(`kill:${ids(WORKSTATION)}`)
    expect(WORKSTATION.every((id) => mutagen.paused(id))).toBe(true)
    expect(result.syncedCount).toBe(2)
  })

  it('fails a machine whose flush errors with the Mutagen message, re-pausing it; others still sync', async () => {
    const { mutagen, run } = harness()
    mutagen.flushBehaviour = (flushed) => flushed.includes('sync_project_decl') ? { error: 'unable to flush session: synchronization cycle failed' } : { ok: true }
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'failed', detail: 'unable to flush session: synchronization cycle failed' })
    expect(result).toMatchObject({ ok: false, failedCount: 1, syncedCount: 2 })
    expect(WORKSTATION.every((id) => mutagen.paused(id))).toBe(true)
  })

  it('fails a machine with a halted session', async () => {
    const { mutagen, run } = harness()
    mutagen.flushBehaviour = (flushed) => flushed.includes('sync_roam_paste') ? 'hang' : { ok: true }
    mutagen.onList = (fake) => {
      if (fake.log.includes(`flush:${ids(WORKSTATION)}`) && !fake.paused('sync_roam_paste')) {fake.set('sync_roam_paste', { status: 'halted-on-root-emptied', lastError: 'root emptied' })}
    }
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.workstation).state).toBe('failed')
    expect(outcome(result, MACHINE_KEYS.workstation).detail).toContain('halted-on-root-emptied: root emptied')
    expect(mutagen.log).toContain(`kill:${ids(WORKSTATION)}`)
  })

  it('lets a resume connect failure keep connecting: unreachable only if it never connects; other resume errors fail', async () => {
    const { mutagen, run } = harness()
    const ssh = 'unable to resume sessions: unable to connect to beta: ssh: connect to host 203.0.113.10 port 22: Operation timed out'
    mutagen.resumedState = (id) => WORKSTATION.includes(id) ? { status: 'connecting-beta', connected: false } : { status: 'watching', connected: true }
    mutagen.resumeError = (resumed) => resumed.includes('sync_project_decl')
      ? new SyncMutagenError(ssh, false)
      : resumed.includes('sync_phi') ? new SyncMutagenError('unable to resume sessions: session is halted', false) : undefined
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'skipped', reason: 'unreachable', detail: ssh })
    expect(mutagen.log.some((entry) => entry.startsWith('flush:sync_project'))).toBe(false)
    expect(outcome(result, MACHINE_KEYS.aws)).toMatchObject({ state: 'failed', detail: 'unable to resume sessions: session is halted' })
    expect(result.failedCount).toBe(1)
    expect([...WORKSTATION, ...AWS].every((id) => mutagen.paused(id))).toBe(true)
  })

  it('syncs a machine whose resume hit a connection hiccup once Mutagen reconnects on its own', async () => {
    const { mutagen, run } = harness()
    // ProxyCommand ssh under load: Mutagen wraps ssh's output; only the last line is the message.
    mutagen.resumeError = (resumed) => resumed.includes('sync_phi')
      ? new SyncMutagenError('Connection to UNKNOWN port 65535 timed out', false, 'Error: unable to resume session: unable to connect to beta: unable to dial agent endpoint: (\nConnection to UNKNOWN port 65535 timed out)\n')
      : undefined
    mutagen.resumedState = (id) => AWS.includes(id) ? { status: 'connecting-beta', connected: false } : { status: 'watching', connected: true }
    let polls = 0
    mutagen.onList = (fake) => {
      polls += 1
      if (polls === 3) {for (const id of AWS) {fake.set(id, { status: 'watching', connected: true })}}
    }
    const result = await run({ stallGraceMs: 2_000 })
    expect(outcome(result, MACHINE_KEYS.aws).state).toBe('synced')
    expect(result).toMatchObject({ ok: true, failedCount: 0 })
    expect(AWS.every((id) => mutagen.paused(id))).toBe(true)
  })

  it('counts a lane that finished its own flush as synced (and runs its after hook) when another lane hits the cap', async () => {
    const calls: string[] = []
    const hooks: SyncHooks = {
      find: (profileId) => ['phi-sessions', 'devbox'].includes(profileId) ? `/hooks/${profileId}` : undefined,
      run: async (path, phase) => { calls.push(`${path}:${phase}`); return undefined }
    }
    const { mutagen, run } = harness({ hooks })
    mutagen.flushBehaviour = () => ({ ok: true })
    mutagen.flushDelayFor = (id) => id.startsWith('sync_devbox') ? 5_000 : 5
    const result = await run({ selection: { device: 'aws' }, timeoutMs: 300 })
    const aws = outcome(result, MACHINE_KEYS.aws)
    expect(aws).toMatchObject({ state: 'skipped', reason: 'timeout' })
    expect(Object.fromEntries(aws.lanes.map((lane) => [lane.laneKey, lane.state]))).toEqual({ 'devbox:workspace': 'skipped', 'phi-sessions:phi-sessions': 'synced' })
    expect(calls.toSorted()).toEqual(['/hooks/devbox:before', '/hooks/phi-sessions:after', '/hooks/phi-sessions:before'])
    expect(AWS.every((id) => mutagen.paused(id))).toBe(true)
  })

  it('keeps going when resume merely timed out (the daemon is still connecting)', async () => {
    const { mutagen, run } = harness()
    mutagen.resumeError = (resumed) => resumed.includes('sync_phi') ? new SyncMutagenError('mutagen sync resume gave no answer within 20 s', true) : undefined
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.aws).state).toBe('synced')
  })

  it('stops gracefully on interrupt: kills flushes, restores pause state, reports interrupted', async () => {
    const { mutagen, run } = harness()
    mutagen.flushBehaviour = () => 'hang'
    const controller = new AbortController()
    const pending = run({}, controller.signal)
    await vi.waitFor(() => expect(mutagen.log.filter((entry) => entry.startsWith('flush:'))).toHaveLength(3))
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, interrupted: true, skippedCount: 3 })
    expect(result.machines.every((machine) => machine.reason === 'interrupted')).toBe(true)
    expect(mutagen.log.filter((entry) => entry.startsWith('kill:'))).toHaveLength(3)
    expect([...WORKSTATION, ...AWS, ...MACMINI].every((id) => mutagen.paused(id))).toBe(true)
  })

  it('leaves the lock wait on interrupt without planning anything', async () => {
    const controller = new AbortController()
    const { mutagen, events, run } = harness({
      acquireLock: async (onWait, signal) => {
        onWait({ pid: 4242, startedAt: 1 })
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        return undefined
      }
    })
    const pending = run({}, controller.signal)
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'lock-wait', holderPid: 4242, holderStartedAt: 1 }))
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ interrupted: true, machines: [] })
    expect(events.map((event) => event.type)).toEqual(['lock-wait', 'finished'])
    expect(mutagen.listCalls).toBe(0)
  })

  it('runs before/after hooks around the sync and turns hook failures into warnings', async () => {
    const calls: string[] = []
    const hooks: SyncHooks = {
      find: (profileId) => ['phi-sessions', 'roam'].includes(profileId) ? `/hooks/${profileId}` : undefined,
      run: async (path, phase, context) => {
        calls.push(`${path}:${phase}:${context.profileId}:${context.user}@${context.host}`)
        return path.endsWith('roam') && phase === 'before' ? 'hook roam before failed (exit 3): nope' : undefined
      }
    }
    const { mutagen, events, run } = harness({ hooks })
    mutagen.flushBehaviour = () => ({ ok: true })
    const result = await run()
    expect(calls.toSorted()).toEqual([
      '/hooks/phi-sessions:after:phi-sessions:alice@devbox',
      '/hooks/phi-sessions:before:phi-sessions:alice@devbox',
      '/hooks/roam:after:roam:sample@203.0.113.10',
      '/hooks/roam:before:roam:sample@203.0.113.10'
    ])
    expect(outcome(result, MACHINE_KEYS.workstation)).toMatchObject({ state: 'synced', warnings: ['hook roam before failed (exit 3): nope'] })
    expect(events).toContainEqual({ type: 'warning', machineKey: MACHINE_KEYS.workstation, message: 'hook roam before failed (exit 3): nope' })
    const phases = events.filter((event) => event.type === 'machine-phase' && event.machineKey === MACHINE_KEYS.aws).map((event) => event.type === 'machine-phase' ? event.phase : '')
    expect(phases.indexOf('preparing')).toBeLessThan(phases.indexOf('connecting'))
    expect(phases).toContain('finishing')
  })

  it('narrows to one profile without touching the rest', async () => {
    const { mutagen, run } = harness()
    const result = await run({ selection: { profile: 'roam' } })
    expect(result.machines.map((machine) => machine.machineKey)).toEqual([MACHINE_KEYS.workstation])
    expect(mutagen.log).toContain('resume:sync_roam_decl,sync_roam_work,sync_roam_creds,sync_roam_paste')
    expect(mutagen.paused('sync_project_decl')).toBe(true)
    expect(mutagen.log.some((entry) => entry.includes('sync_project'))).toBe(false)
  })

  it('rejects an unknown selection cleanly and releases the lock', async () => {
    const { mutagen, release, run } = harness()
    await expect(run({ selection: { device: 'nope' } })).rejects.toBeInstanceOf(CliArgumentError)
    expect(release).toHaveBeenCalledOnce()
    expect(mutagen.log).toEqual([])
  })

  it('trusts a pause that outlived its CLI call once the daemon reports the sessions paused', async () => {
    const landed = harness()
    landed.mutagen.pauseError = () => ({ error: new SyncMutagenError('mutagen sync pause gave no answer within 60 s', true), lands: true })
    const result = await landed.run()
    expect(result.machines.every((machine) => machine.warnings.length === 0)).toBe(true)
    expect([...WORKSTATION, ...AWS].every((id) => landed.mutagen.paused(id))).toBe(true)

    const stuck = harness()
    stuck.mutagen.pauseError = (paused) => paused.includes('sync_phi') ? { error: new SyncMutagenError('mutagen sync pause gave no answer within 60 s', true), lands: false } : undefined
    const warned = await stuck.run()
    expect(outcome(warned, MACHINE_KEYS.aws).warnings).toEqual(['3 session(s) still pausing (Mutagen finishes the running scan first); the next `db sync` pauses them if they are still running'])
    expect(outcome(warned, MACHINE_KEYS.workstation).warnings).toEqual([])
  })

  it('keeps a session whose pause was lost tracked, asks again at the end, and the next run pauses it', async () => {
    // 2026-10-13: a hung daemon timed out the re-pause; the run forgot those sessions and every
    // later run treated them as user-live, so they live-synced ~/project for two days.
    const { mutagen, events, run } = harness()
    mutagen.pauseError = (paused) => paused.includes('sync_phi') ? { error: new SyncMutagenError('mutagen sync pause gave no answer within 60 s', true), lands: false } : undefined
    await run()
    expect(mutagen.log.filter((entry) => entry === `pause:${ids(AWS)}`).length).toBeGreaterThanOrEqual(2)
    expect(AWS.some((id) => mutagen.paused(id))).toBe(false)
    expect(events.some((event) => event.type === 'warning' && event.machineKey === undefined && /still pausing/u.test(event.message))).toBe(true)

    mutagen.pauseError = () => undefined
    mutagen.log.length = 0
    const next = await run()
    expect(next.ok).toBe(true)
    expect([...WORKSTATION, ...AWS, ...MACMINI].every((id) => mutagen.paused(id))).toBe(true)
  })

  it('pauses sessions found running on a machine it skips (unreachable), without resuming anything there', async () => {
    const { mutagen, run } = harness({ reachable: { macmini: { ok: false, reason: 'unreachable', detail: 'no answer' } } })
    const result = await run()
    expect(outcome(result, MACHINE_KEYS.macmini)).toMatchObject({ state: 'skipped', reason: 'unreachable' })
    expect(mutagen.log.filter((entry) => entry.includes('sync_macmini'))).toEqual([`pause:${ids(MACMINI)}`])
    expect(MACMINI.every((id) => mutagen.paused(id))).toBe(true)
  })

  it('hands still-resumed sessions to a detached pause on a hard exit, and leaves no exit hook behind', async () => {
    const mutagen = new FakeMutagen(REAL_SESSIONS)
    const tracker = createPauseTracker(mutagen)
    tracker.markResumed(['sync_phi', 'sync_devbox_decl'])
    await tracker.repause(['sync_phi'])
    tracker.abandon()
    tracker.abandon()
    expect(mutagen.log.filter((entry) => entry.startsWith('detached-pause:'))).toEqual(['detached-pause:sync_devbox_decl'])
    const before = process.listenerCount('exit')
    await harness().run()
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('keeps waiting through a silent daemon (busy, not hung): a muted note, then the cap ends it as a timeout', async () => {
    const { mutagen, events, run } = harness()
    mutagen.flushBehaviour = () => {
      mutagen.listFailures = 1_000_000
      return 'hang'
    }
    const result = await run({ stallGraceMs: 20, busyNoteMs: 30, timeoutMs: 400 })
    for (const machine of result.machines) {
      expect(machine).toMatchObject({ state: 'skipped', reason: 'timeout' })
      expect(machine.elapsedMs).toBeGreaterThanOrEqual(400)
    }
    const notes = events.flatMap((event) => event.type === 'machine-phase' && event.detail !== undefined ? [event.detail] : [])
    expect(notes.some((detail) => /^Mutagen busy · no status for \d/u.test(detail))).toBe(true)
    expect(mutagen.log.filter((entry) => entry.startsWith('kill:'))).toHaveLength(3)
    expect([...WORKSTATION, ...AWS].every((id) => mutagen.paused(id))).toBe(true)
  })

  it('does not count daemon silence toward the stall rule; the note clears once polls answer again', async () => {
    const { mutagen, events, run } = harness()
    mutagen.resumedState = () => ({ status: 'connecting-beta', connected: false })
    let stage = 0
    mutagen.onList = (fake) => {
      if (!fake.log.some((entry) => entry.startsWith('resume:'))) {return}
      stage += 1
      // 1st answer: endpoints connecting; then ~200 failed polls (>= 400 ms of silence, far past
      // the 100 ms grace); 2nd answer: still connecting; 3rd answer: connected.
      if (stage === 1) {fake.listFailures = 200}
      if (stage === 3) {for (const id of [...WORKSTATION, ...AWS]) {fake.set(id, { status: 'watching', connected: true })}}
    }
    const result = await run({ stallGraceMs: 100, busyNoteMs: 20, timeoutMs: 10_000 })
    expect(result).toMatchObject({ syncedCount: 3, skippedCount: 0 })
    const aws = result.machines.find((machine) => machine.machineKey.includes('devbox'))?.machineKey ?? result.machines[0]!.machineKey
    const details = events.flatMap((event) => event.type === 'machine-phase' && event.machineKey === aws ? [event.detail] : [])
    const lastNote = details.findLastIndex((detail) => detail?.startsWith('Mutagen busy · no status for') === true)
    expect(lastNote).toBeGreaterThanOrEqual(0)
    expect(details.slice(lastNote + 1)).toContain(undefined)
  })

  it('warns about failing status polls only once they persist, and hands every failure to listeners', async () => {
    let clock = 0
    const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(() => {
      clock += 4_000
      resolve()
    }, 0))
    const warnings: number[] = []
    let calls = 0
    const flaky = { list: async () => { calls += 1; if (calls === 1) {throw new Error('connection timed out')} return [] } }
    const recovered = createSyncPoller(flaky, 1, sleep, (_error, forMs) => warnings.push(forMs), () => clock)
    const once: unknown[] = []
    const stopOnce = recovered.subscribe((sessions) => once.push(sessions))
    await vi.waitFor(() => expect(once.length).toBeGreaterThanOrEqual(4))
    stopOnce()
    recovered.stop()
    expect(once[0]).toBeUndefined()
    expect(once[1]).toEqual([])
    const down = createSyncPoller({ list: async () => { throw new Error('connection timed out') } }, 1, sleep, (_error, forMs) => warnings.push(forMs), () => clock)
    const seen: unknown[] = []
    const stopDown = down.subscribe((sessions) => seen.push(sessions))
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(6))
    stopDown()
    down.stop()
    expect(seen.every((sessions) => sessions === undefined)).toBe(true)
    expect(warnings).toEqual([12_000])
  })

  it('starts the daemon through the service once when it is not answering, else fails cleanly', async () => {
    const started = harness()
    started.mutagen.listFailures = 1
    expect((await started.run()).syncedCount).toBe(3)
    expect(started.deps.startDaemon).toHaveBeenCalledOnce()

    const down = harness({ startDaemon: vi.fn(async () => { throw new Error('launchctl kickstart failed') }) })
    down.mutagen.listFailures = 5
    await expect(down.run()).rejects.toThrow('could not be started (launchctl kickstart failed)')
    expect(down.release).toHaveBeenCalledOnce()
  })
})
