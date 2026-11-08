import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  demoPlan,
  demoScript,
  finished,
  harness,
  laneEvent,
  outcome,
  phaseEvent,
  progress,
  staging,
  type Harness
} from './sync-now-render-fixture'
import { HEARTBEAT_EVERY_MS, PROGRESS_EVERY_MS } from './sync-now-render-plain'

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z {2}/u

function lines(run: Harness): string[] {
  return run.stderr.join('').split('\n').filter((line) => line !== '')
}

function bodies(run: Harness): string[] {
  return lines(run).map((line) => line.replace(STAMP, ''))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('db sync plain renderer', () => {
  it('logs one UTC-stamped line per meaningful change, without cursor control or colour', () => {
    const run = harness({ mode: 'plain' })
    for (const [at, event] of demoScript()) {run.at(at, event)}
    const all = lines(run)
    expect(all.every((line) => STAMP.test(line))).toBe(true)
    expect(all[0]).toBe('2026-10-12T18:22:31Z  db sync · 3 machines (devbox, macmini, workstation) · 7 lanes')
    expect(run.stderr.join('')).not.toContain('\x1b')
    expect(bodies(run)).toEqual(expect.arrayContaining([
      'devbox       checking',
      'workstation  checking · ssh probe',
      'devbox       scanning',
      'macmini      synced in 4.1 s',
      'devbox       phi sessions ~/.pi/agent/session-sync: synced',
      'workstation  skipped: unreachable (no answer in 6 s)',
      'devbox       warning: conflict in workspace ~/project: devbox/README.md changed on both sides',
      'devbox       finishing · re-pausing 1 session',
      'devbox       synced in 3:02 (3,350 files · 512 MB, 1 conflict)'
    ]))
    expect(all.at(-1)).toBe('2026-10-12T18:25:33Z  2 synced · 1 skipped in 3:02')
    // The warning arrives twice (event + outcome) but is logged once.
    expect(bodies(run).filter((line) => line.includes('warning:'))).toHaveLength(1)
  })

  it('logs a phase once even when the engine repeats it', () => {
    const run = harness({ mode: 'plain' })
    run.at(0, { type: 'plan', plan: demoPlan() })
    run.at(100, phaseEvent('devbox', 'scanning'))
    run.at(200, phaseEvent('devbox', 'scanning'))
    run.at(300, phaseEvent('devbox', 'scanning', 'remote side'))
    expect(bodies(run).slice(1)).toEqual(['devbox       scanning', 'devbox       scanning · remote side'])
  })

  it('throttles transfer progress to one line per machine every ten seconds', () => {
    const run = harness({ mode: 'plain' })
    run.at(0, { type: 'plan', plan: demoPlan() })
    run.at(1000, phaseEvent('devbox', 'transferring'))
    run.at(1000, phaseEvent('macmini', 'transferring'))
    for (let second = 1; second <= 35; second += 1) {
      for (const machine of ['devbox', 'macmini']) {
        run.at(1000 + second * 1000, laneEvent(machine, `${machine}:workspace`, progress('transferring', { staging: staging(second * 10, 400, second * 1_000_000) })))
      }
    }
    const devbox = bodies(run).filter((line) => line.startsWith('devbox       transferring'))
    expect(devbox).toEqual([
      'devbox       transferring',
      'devbox       transferring 100/400 files · 10 MB (25%)',
      'devbox       transferring 200/400 files · 20 MB (50%)',
      'devbox       transferring 300/400 files · 30 MB (75%)'
    ])
    expect(bodies(run).filter((line) => line.startsWith('macmini      transferring'))).toHaveLength(4)
    expect(PROGRESS_EVERY_MS).toBe(10_000)
  })

  it('says `still scanning` once a minute during long quiet phases, from events or its own timer', () => {
    vi.useFakeTimers()
    const run = harness({ mode: 'plain' })
    run.at(0, { type: 'plan', plan: demoPlan() })
    run.at(1000, phaseEvent('devbox', 'scanning'))
    run.at(30_000, laneEvent('devbox', 'devbox:workspace', progress('scanning')))
    run.at(61_000, laneEvent('devbox', 'devbox:workspace', progress('scanning')))
    expect(bodies(run).at(-1)).toBe('devbox       still scanning · 1:00')
    // No engine events for two minutes: the renderer's own timer keeps the log alive.
    run.clock.now += 2 * HEARTBEAT_EVERY_MS
    vi.advanceTimersByTime(5000)
    expect(bodies(run).at(-1)).toBe('devbox       still scanning · 3:00')
    run.at(200_000, finished([outcome('devbox', 'synced', 199_000)], 200_000))
    const count = run.stderr.length
    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS * 3)
    expect(run.stderr).toHaveLength(count)
  })

  it('logs skipped, failed and conflicted machines, then a tally, and leaves the summary on stdout', () => {
    const run = harness({ mode: 'plain', width: 100 })
    run.at(0, { type: 'plan', plan: demoPlan() })
    const outcomes = [
      outcome('devbox', 'failed', 62_000, { detail: 'Mutagen:\nunable to connect to beta', conflicts: 2 }),
      outcome('macmini', 'skipped', 6000, { reason: 'stopped', detail: 'stopped (db sync --wake starts it)' }),
      outcome('workstation', 'skipped', 30_000, { reason: 'stalled', detail: '30 s' })
    ]
    for (const item of outcomes) {run.at(item.elapsedMs, { type: 'machine-done', outcome: item })}
    run.at(63_000, finished(outcomes, 63_000, true))
    expect(bodies(run).slice(1)).toEqual([
      'devbox       failed after 1:02: Mutagen: unable to connect to beta, 2 conflicts',
      'macmini      skipped: stopped (db sync --wake starts it)',
      'workstation  skipped: stalled (30 s)',
      '2 skipped · 1 failed · interrupted in 1:03'
    ])
    const summary = run.stdout.join('').split('\n')
    expect(summary.at(-2)).toMatch(/^2 skipped · 1 failed · interrupted +1:03$/u)
    expect(summary.some((line) => line.startsWith('✗ devbox'))).toBe(true)
    expect(summary.every((line) => [...line].length <= 100)).toBe(true)
  })

  it('reports the lock holder once, then ignores everything after finished', () => {
    const run = harness({ mode: 'plain' })
    run.at(0, { type: 'lock-wait', holderPid: 4242 })
    run.at(5000, { type: 'lock-wait', holderPid: 4242 })
    run.at(9000, { type: 'lock-wait', holderPid: 5151, holderCommand: 'db mutagen restart' })
    run.at(10_000, { type: 'plan', plan: { ...demoPlan(), machines: [] } })
    run.at(10_001, finished([], 1))
    run.at(10_002, phaseEvent('devbox', 'scanning'))
    run.renderer.close()
    run.renderer.close()
    expect(bodies(run)).toEqual([
      'waiting for another db sync (pid 4242)',
      'waiting for db mutagen restart (pid 5151)',
      'db sync · nothing to sync',
      'nothing to sync in 0.0 s'
    ])
    expect(run.stdout.join('')).toBe(`${'nothing to sync'.padEnd(75)}0.0 s\n`)
  })

  it('colours outcome words only when the presentation enables colour', () => {
    const run = harness({ mode: 'plain', color: true })
    run.at(0, { type: 'plan', plan: demoPlan() })
    run.at(4000, { type: 'machine-done', outcome: outcome('macmini', 'synced', 4000) })
    expect(run.stderr.at(-1)).toContain('\x1b[32msynced\x1b[0m')
    // Colour (SGR) only: every escape is `ESC[…m`, never cursor movement or erase.
    const escapes = run.stderr.join('').split('\u001b').slice(1)
    expect(escapes.length).toBeGreaterThan(0)
    expect(escapes.every((part) => /^\[[\d;]*m/u.test(part))).toBe(true)
  })
})
