import { afterEach, describe, expect, it, vi } from 'vitest'
import { stripAnsi } from './presentation'
import {
  cells,
  demoPlan,
  demoScript,
  eraseHeights,
  finished,
  harness as createHarness,
  HIDE,
  lane,
  laneEvent,
  liveFrames,
  outcome,
  phaseEvent,
  progress,
  SHOW,
  staging,
  stripControl,
  type Harness,
  type HarnessOptions
} from './sync-now-render-fixture'
import type { SyncNowEvent, SyncNowPlan } from './sync-now-types'

function replay(run: Harness, script: readonly [number, SyncNowEvent][]): void {
  for (const [at, event] of script) {run.at(at, event)}
}

/** Every line the user could ever see: all live frames plus the final summary. */
function everyLine(run: Harness): string[] {
  return [...liveFrames(run.stderr).flat(), ...run.stdout.join('').split('\n')]
}

/** A plan built to break layouts: long names, endpoints, labels, paths and messages. */
function hostilePlan(): SyncNowPlan {
  const plan = demoPlan()
  return {
    ...plan,
    machines: [
      ...plan.machines,
      {
        key: 'long',
        name: 'a-machine-name-that-goes-on-for-a-while',
        user: 'someone-with-a-long-username',
        host: 'ec2-203-0-113-250.us-west-2.compute.amazonaws.com',
        port: 2222,
        proxied: true,
        lanes: [lane('long', 'other', 'a lane label that is too long', '~/projects/clients/acme/very/deep/nested/workspace/root')]
      }
    ]
  }
}

const HOSTILE_ERROR = `Mutagen: unable to connect to beta: \n${'x'.repeat(40)} ssh: connect to host 203.0.113.250 port 2222: Operation timed out\tretrying`.repeat(3)

function hostileScript(): [number, SyncNowEvent][] {
  return [
    [0, { type: 'lock-wait', holderPid: 4242, holderStartedAt: 0 }],
    [0, { type: 'plan', plan: hostilePlan() }],
    ...demoScript().filter(([, event]) => event.type !== 'plan' && event.type !== 'finished'),
    [700, phaseEvent('long', 'waking', 'asking AWS to start i-0123456789abcdef0 (this can take a minute or two)')],
    [9000, laneEvent('long', 'long:other', progress('transferring', { conflicts: 12_345, problems: 3, staging: staging(1_234_567, 9_876_543, 123_456_789_012, 999_999_999_999) }))],
    [9500, { type: 'warning', machineKey: 'long', message: 'before hook failed: '.repeat(10) }],
    [9600, { type: 'warning', message: 'global: '.repeat(20) }],
    [190_000, { type: 'machine-done', outcome: outcome('long', 'failed', 190_000, { detail: HOSTILE_ERROR, conflicts: 12_345, problems: 3 }) }]
  ]
}

const opened: Harness[] = []

/** Every renderer a test opens is closed afterwards, so no timer or exit hook outlives it. */
function harness(options: HarnessOptions = {}): Harness {
  const run = createHarness(options)
  opened.push(run)
  return run
}

afterEach(() => {
  for (const run of opened.splice(0)) {run.renderer.close()}
  vi.useRealTimers()
})

describe('db sync live renderer', () => {
  it('never draws a line wider than the terminal', () => {
    for (const width of [1, 3, 8, 12, 20, 30, 40, 60, 80, 120]) {
      for (const glyphs of [true, false]) {
        const run = harness({ width, glyphs })
        replay(run, hostileScript())
        run.at(195_000, finished([], 195_000))
        const lines = everyLine(run)
        expect(lines.length).toBeGreaterThan(10)
        const wide = lines.filter((line) => cells(line) > width)
        expect(wide, `width ${width} glyphs ${glyphs}`).toEqual([])
      }
    }
  })

  it('stays inside the terminal at the brief widths for the realistic run', () => {
    for (const width of [40, 60, 80, 120]) {
      const run = harness({ width, color: true })
      replay(run, demoScript())
      expect(everyLine(run).filter((line) => cells(line) > width)).toEqual([])
      // Right-aligned elapsed lands on the last column of machine rows.
      const machineRows = run.stdout.join('').split('\n').filter((line) => /^[✓○✗]/u.test(stripAnsi(line)))
      expect(machineRows.map((line) => cells(line))).toEqual(machineRows.map(() => width))
    }
  })

  it('hides the cursor while live, restores it on finish, and close stays idempotent', () => {
    const run = harness()
    replay(run, demoScript().slice(0, 6))
    expect(run.stderr[0]!.startsWith('\x1b[?2026h\x1b[?25l')).toBe(true)
    expect(run.stderr.join('').split(HIDE)).toHaveLength(2)
    expect(run.stderr.join('')).not.toContain(SHOW)
    replay(run, demoScript().slice(6))
    expect(run.stderr.at(-1)!.endsWith(SHOW)).toBe(true)
    const writes = run.stderr.length
    run.renderer.close()
    run.renderer.close()
    expect(run.stderr).toHaveLength(writes)
    expect(run.stdout.join('')).toContain('2 synced · 1 skipped')
  })

  it('on Ctrl-C (close without finished) erases the board, restores the cursor, prints nothing', () => {
    const run = harness()
    replay(run, demoScript().slice(0, 8))
    const lastFrame = liveFrames(run.stderr).at(-1)!
    run.renderer.close()
    expect(run.stderr.at(-1)).toBe(`\x1b[${lastFrame.length}F\x1b[J${SHOW}`)
    run.renderer.close()
    run.at(9000, phaseEvent('devbox', 'scanning'))
    expect(run.stderr.at(-1)).toBe(`\x1b[${lastFrame.length}F\x1b[J${SHOW}`)
    expect(run.stdout).toEqual([])
  })

  it('draws nothing before the first event, and a fresh plan is all queued with no spinner', () => {
    const idle = harness()
    idle.renderer.close()
    expect(idle.stderr).toEqual([])
    const run = harness()
    run.at(0, { type: 'plan', plan: demoPlan() })
    const frame = liveFrames(run.stderr).at(-1)!
    expect(frame.filter((line) => line.startsWith('· '))).toHaveLength(3)
    expect(frame.join('\n')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u)
    expect(frame.at(-1)).toMatch(/^3 queued +ctrl-c to stop$/u)
  })

  it('redraws in place: each frame erases exactly the previous one', () => {
    const run = harness()
    replay(run, demoScript())
    const frames = run.stderr.filter((write) => write.includes('\x1b[?2026h'))
    expect(frames.length).toBeGreaterThan(10)
    for (let index = 1; index < frames.length; index += 1) {
      const previous = stripControl(frames[index - 1]!).replace(/\n$/u, '').split('\n').length
      expect(eraseHeights(frames[index]!)).toEqual([previous])
    }
  })

  it('re-reads the width every frame and erases rows a narrowed terminal re-wrapped', () => {
    const run = harness({ width: 100 })
    replay(run, demoScript().slice(0, 10))
    const before = liveFrames(run.stderr).at(-1)!
    run.stream.columns = 50
    run.at(5000, laneEvent('devbox', 'devbox:workspace', progress('scanning')))
    const wrapped = before.reduce((sum, line) => sum + Math.max(1, Math.ceil(cells(line) / 50)), 0)
    expect(wrapped).toBeGreaterThan(before.length)
    expect(eraseHeights(run.stderr.at(-1)!)).toEqual([wrapped])
    expect(liveFrames(run.stderr).at(-1)!.every((line) => cells(line) <= 50)).toBe(true)
  })

  it('keeps the board inside a short terminal: lanes fold first, then finished machines', () => {
    const tall = harness({ rows: 40 })
    const short = harness({ rows: 9 })
    const tiny = harness({ rows: 4 })
    for (const run of [tall, short, tiny]) {replay(run, demoScript().slice(0, 14))}
    const tallFrame = liveFrames(tall.stderr).at(-1)!
    expect(tallFrame).toHaveLength(9)
    expect(tallFrame.join('\n')).toContain('phi sessions')
    const shortFrame = liveFrames(short.stderr).at(-1)!
    expect(shortFrame.length).toBeLessThanOrEqual(8)
    expect(shortFrame.join('\n')).toContain('macmini')
    const tinyFrame = liveFrames(tiny.stderr).at(-1)!
    expect(tinyFrame.length).toBeLessThanOrEqual(3)
    expect(tinyFrame[0]).toContain('db sync')
    expect(tinyFrame.join('\n')).toContain('devbox')
  })

  it('prints a clean, aligned final summary to stdout', () => {
    const run = harness({ width: 80 })
    replay(run, demoScript())
    const summary = run.stdout.join('')
    expect(summary).not.toContain('\x1b')
    expect(summary.split('\n')).toEqual([
      '✓ devbox       i-0f3a9c2e71b4d5a68    synced · 3,350 files · 1 conflict     3:02',
      '    workspace     ~/project           synced · 3,310 files · 1 conflict',
      '    phi sessions  ~/…/session-sync    synced · 40 files',
      '    ! conflict in workspace ~/project: devbox/README.md changed on both sides',
      '✓ macmini      192.0.2.12             synced                               4.1 s',
      '○ workstation  203.0.113.10:2222      skipped · unreachable                6.0 s',
      // The reason the row had no room for gets its own line in scrollback.
      '    no answer in 6 s',
      '',
      '2 synced · 1 skipped                                                        3:02',
      ''
    ])
  })

  it('shows the full board mid-run: spinner only on active rows, progress bar, tally and hint', () => {
    const run = harness({ width: 80 })
    replay(run, demoScript().filter(([at]) => at <= 150_000))
    expect(liveFrames(run.stderr).at(-1)).toEqual([
      'db sync · 3 machines · 7 lanes                                              2:27',
      '',
      '⠋ devbox       i-0f3a9c2e71b4d5a68    transferring · 38% · 196 MB           2:27',
      '    workspace     ~/project           ━━━━────────  1,273/3,310 files · 196 MB',
      '    phi sessions  ~/…/session-sync    synced · 40 files',
      '✓ macmini      192.0.2.12             synced                               4.1 s',
      '○ workstation  203.0.113.10:2222      skipped · unreachable                6.0 s',
      '',
      '1 synced · 1 skipped · 1 running                                  ctrl-c to stop'
    ])
  })

  it('falls back to ASCII: words for states, a -\\|/ spinner, ... for ellipses', () => {
    const run = harness({ glyphs: false })
    replay(run, demoScript())
    const text = everyLine(run).join('\n')
    expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✗○━─…]/u)
    expect(text).toContain('ok   macmini')
    expect(text).toContain('skip workstation')
    expect(text).toMatch(/^[-\\|/] {4}devbox/mu)
    expect(text).toMatch(/=+-+ {2}\d/u)
  })

  it('renders failures, warning-level skips, stopped boxes and conflicts with meaning-only colour', () => {
    const run = harness({ width: 120, color: true })
    const plan = demoPlan()
    run.at(0, { type: 'plan', plan })
    const outcomes = [
      outcome('workstation', 'skipped', 30_500, { reason: 'stalled', detail: 'stalled 30 s' }),
      outcome('macmini', 'skipped', 600, { reason: 'stopped', detail: 'stopped (db sync --wake starts it)' }),
      outcome('devbox', 'failed', 700, { detail: `rsync-like error: ${'disk full '.repeat(30)}`, conflicts: 2, problems: 1 })
    ]
    for (const [index, item] of outcomes.entries()) {run.at(500 + index * 100, { type: 'machine-done', outcome: item })}
    run.at(800, finished(outcomes, 800))
    const lines = run.stdout.join('').split('\n')
    const devbox = lines.find((line) => stripAnsi(line).includes('devbox'))!
    expect(devbox).toContain('\x1b[31m✗\x1b[0m')
    expect(devbox).toContain('\x1b[31mfailed\x1b[0m')
    expect(devbox).toContain('\x1b[33m · 2 conflicts\x1b[0m')
    expect(stripAnsi(devbox)).toMatch(/failed · 2 conflicts · 1 problem · rsync-like error: disk full .*… +0\.7 s$/u)
    const workstation = lines.find((line) => stripAnsi(line).includes('workstation'))!
    expect(workstation).toContain('\x1b[33m○\x1b[0m')
    expect(stripAnsi(workstation)).toContain('skipped · stalled 30 s')
    const macmini = lines.find((line) => stripAnsi(line).includes('macmini'))!
    expect(macmini).toContain('\x1b[2m○\x1b[0m')
    expect(stripAnsi(macmini)).toContain('skipped · stopped (db sync --wake starts it)')
    expect(stripAnsi(lines.at(-2)!)).toMatch(/^2 skipped · 1 failed +0\.8 s$/u)
  })

  it('emits no colour at all when the presentation disables it', () => {
    const run = harness({ color: false })
    replay(run, demoScript())
    expect(everyLine(run).some((line) => line.includes('\x1b['))).toBe(false)
  })

  it('never shows the tree\'s file count next to `transferring` (it would read as files being sent)', () => {
    const run = harness({ width: 100 })
    run.at(0, { type: 'plan', plan: demoPlan() })
    run.at(1000, laneEvent('macmini', 'macmini:workspace', progress('scanning', { files: 615_992 })))
    expect(liveFrames(run.stderr).at(-1)!.join('\n')).toContain('scanning · 615,992 files')
    run.at(2000, laneEvent('macmini', 'macmini:workspace', progress('transferring', { files: 615_992 })))
    const frame = liveFrames(run.stderr).at(-1)!.join('\n')
    expect(frame).toMatch(/workspace +~\/project +transferring/u)
    expect(frame).not.toContain('615,992')
  })

  it('shows a single spinner line while waiting for the lock, then replaces it with the board', () => {
    const run = harness({ width: 80 })
    const holderStartedAt = run.clock.now - 65_000
    run.at(0, { type: 'lock-wait', holderPid: 4242, holderStartedAt })
    run.at(12_000, { type: 'lock-wait', holderPid: 4242, holderStartedAt })
    const [frame] = liveFrames(run.stderr).slice(-1)
    expect(frame).toHaveLength(1)
    expect(frame![0]).toMatch(/^⠋ waiting for another db sync to finish \(pid 4242, started 1:17 ago\) +0:12$/u)
    run.at(13_000, { type: 'plan', plan: demoPlan(run.clock.now) })
    expect(eraseHeights(run.stderr.at(-1)!)).toEqual([1])
    expect(liveFrames(run.stderr).at(-1)![0]).toContain('db sync · 3 machines')
  })

  it('keeps only the latest warning per machine, muted under it', () => {
    const run = harness({ width: 100 })
    run.at(0, { type: 'plan', plan: demoPlan() })
    run.at(100, phaseEvent('devbox', 'preparing'))
    run.at(200, { type: 'warning', machineKey: 'devbox', message: 'first warning' })
    run.at(300, { type: 'warning', machineKey: 'devbox', message: 'second\nwarning' })
    const frame = liveFrames(run.stderr).at(-1)!.join('\n')
    expect(frame).not.toContain('first warning')
    expect(frame).toContain('    ! second warning')
  })

  it('animates on the interval and goes quiet after finishing', () => {
    vi.useFakeTimers()
    const run = harness({ intervalMs: 100 })
    replay(run, demoScript().slice(0, 5))
    const before = run.stderr.length
    run.clock.now += 100
    vi.advanceTimersByTime(100)
    expect(run.stderr.length).toBe(before + 1)
    expect(liveFrames(run.stderr).at(-1)!.join('\n')).toContain('⠙ devbox')
    replay(run, demoScript().slice(5))
    const after = run.stderr.length
    vi.advanceTimersByTime(1000)
    expect(run.stderr.length).toBe(after)
  })
})
