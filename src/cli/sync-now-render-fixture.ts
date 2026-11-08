import { createPresentation, stripAnsi } from './presentation'
import { createSyncNowRenderer } from './sync-now-render'
import type {
  SyncLane,
  SyncLaneKind,
  SyncLaneProgress,
  SyncMachineOutcome,
  SyncNowEvent,
  SyncNowPlan,
  SyncNowRenderer,
  SyncNowRenderMode,
  SyncNowResult,
  SyncPhase
} from './sync-now-types'

/** Test-only fixtures for the `db sync` renderers: a realistic plan, event builders, fake streams. */

export const T0 = Date.UTC(2026, 9, 12, 18, 22, 31)

export function lane(machine: string, kind: SyncLaneKind, label: string, localPath: string, suffix = ''): SyncLane {
  return { key: `${machine}:${kind}${suffix}`, kind, label, profileId: label, localPath, remotePath: localPath, sessionIds: [`${machine}-${kind}${suffix}`], pausedBefore: [] }
}

export function demoPlan(startedAt = T0): SyncNowPlan {
  return {
    startedAt,
    timeoutMs: 600_000,
    machines: [
      { key: 'devbox', name: 'devbox', user: 'ubuntu', host: 'i-0f3a9c2e71b4d5a68', port: 22, proxied: true, lanes: [
        lane('devbox', 'workspace', 'workspace', '~/project'),
        lane('devbox', 'phi-sessions', 'phi sessions', '~/.pi/agent/session-sync')
      ] },
      { key: 'macmini', name: 'macmini', user: 'exampleuser', host: '192.0.2.12', port: 22, proxied: false, lanes: [lane('macmini', 'workspace', 'workspace', '~/project')] },
      { key: 'workstation', name: 'workstation', user: 'sample', host: '203.0.113.10', port: 2222, proxied: false, lanes: [
        lane('workstation', 'workspace', 'workspace', '~/project'),
        lane('workstation', 'workspace', 'workspace', '~/scratch/roam', '-roam'),
        lane('workstation', 'images', 'images', '~/.devbox/paste'),
        lane('workstation', 'credentials', 'credentials', '~/.mcp-auth')
      ] }
    ]
  }
}

export function progress(phase: SyncPhase, extra: Partial<SyncLaneProgress> = {}): SyncLaneProgress {
  return { phase, conflicts: 0, problems: 0, ...extra }
}

export function laneEvent(machineKey: string, laneKey: string, value: SyncLaneProgress): SyncNowEvent {
  return { type: 'lane-progress', machineKey, laneKey, progress: value }
}

export function phaseEvent(machineKey: string, phase: SyncPhase, detail?: string): SyncNowEvent {
  return { type: 'machine-phase', machineKey, phase, ...(detail === undefined ? {} : { detail }) }
}

export function staging(received: number, expected: number, bytes: number, expectedBytes?: number): SyncLaneProgress['staging'] {
  return { receivedFiles: received, expectedFiles: expected, receivedBytes: bytes, ...(expectedBytes === undefined ? {} : { expectedBytes }) }
}

export function outcome(machineKey: string, state: SyncMachineOutcome['state'], elapsedMs: number, extra: Partial<SyncMachineOutcome> = {}): SyncMachineOutcome {
  return { machineKey, state, elapsedMs, conflicts: 0, problems: 0, warnings: [], lanes: [], ...extra }
}

export function finished(outcomes: readonly SyncMachineOutcome[], elapsedMs: number, interrupted = false): SyncNowEvent {
  const count = (state: SyncMachineOutcome['state']): number => outcomes.filter((item) => item.state === state).length
  const result: SyncNowResult = {
    ok: count('failed') === 0,
    startedAt: T0,
    elapsedMs,
    machines: [...outcomes],
    syncedCount: count('synced'),
    skippedCount: count('skipped'),
    failedCount: count('failed'),
    interrupted
  }
  return { type: 'finished', result }
}

/** The run from the design brief: devbox scans then transfers; macmini has nothing to do; workstation is unreachable. */
export function demoScript(): [number, SyncNowEvent][] {
  const devboxDone = outcome('devbox', 'synced', 182_000, {
    conflicts: 1,
    warnings: ['conflict in workspace ~/project: devbox/README.md changed on both sides'],
    lanes: [
      { laneKey: 'devbox:workspace', state: 'synced', conflicts: 1, problems: 0, files: 61_874 },
      { laneKey: 'devbox:phi-sessions', state: 'synced', conflicts: 0, problems: 0, files: 212 }
    ]
  })
  const macminiDone = outcome('macmini', 'synced', 4100, { lanes: [{ laneKey: 'macmini:workspace', state: 'synced', conflicts: 0, problems: 0, files: 48_210 }] })
  const workstationDone = outcome('workstation', 'skipped', 6000, { reason: 'unreachable', detail: 'no answer in 6 s' })
  const transfer = Array.from({ length: 12 }, (_, index): [number, SyncNowEvent] => {
    const share = (index + 1) / 13
    return [133_000 + index * 3500, laneEvent('devbox', 'devbox:workspace', progress('transferring', {
      conflicts: index >= 8 ? 1 : 0,
      staging: staging(Math.round(3310 * share), 3310, Math.round(510_000_000 * share), 510_000_000)
    }))]
  })
  const script: [number, SyncNowEvent][] = [
    [0, { type: 'plan', plan: demoPlan() }],
    [0, phaseEvent('devbox', 'checking')],
    [0, phaseEvent('macmini', 'checking')],
    [0, phaseEvent('workstation', 'checking', 'ssh probe')],
    [500, phaseEvent('devbox', 'connecting')],
    [900, phaseEvent('macmini', 'scanning')],
    [900, laneEvent('macmini', 'macmini:workspace', progress('scanning'))],
    [1200, phaseEvent('devbox', 'scanning')],
    [1200, laneEvent('devbox', 'devbox:workspace', progress('scanning'))],
    [1200, laneEvent('devbox', 'devbox:phi-sessions', progress('scanning'))],
    [3500, laneEvent('devbox', 'devbox:phi-sessions', progress('transferring', { staging: staging(12, 40, 1_800_000) }))],
    [4100, { type: 'machine-done', outcome: macminiDone }],
    [4600, laneEvent('devbox', 'devbox:phi-sessions', progress('synced', { files: 212 }))],
    [6000, { type: 'machine-done', outcome: workstationDone }],
    [60_000, laneEvent('devbox', 'devbox:workspace', progress('scanning'))],
    [130_000, phaseEvent('devbox', 'reconciling')],
    [132_000, phaseEvent('devbox', 'transferring')],
    ...transfer,
    [161_000, { type: 'warning', machineKey: 'devbox', message: 'conflict in workspace ~/project: devbox/README.md changed on both sides' }],
    [180_000, phaseEvent('devbox', 'finishing', 're-pausing 1 session')],
    [182_000, { type: 'machine-done', outcome: devboxDone }],
    [182_300, finished([devboxDone, macminiDone, workstationDone], 182_300)]
  ]
  return script.sort((left, right) => left[0] - right[0])
}

export type Harness = {
  renderer: SyncNowRenderer
  stdout: string[]
  stderr: string[]
  stream: { columns?: number; rows?: number }
  clock: { now: number }
  /** Advance the clock to `T0 + at` and deliver the event. */
  at(at: number, event: SyncNowEvent): void
}

export type HarnessOptions = {
  mode?: SyncNowRenderMode
  width?: number
  rows?: number
  glyphs?: boolean
  color?: boolean
  intervalMs?: number
}

export function harness(options: HarnessOptions = {}): Harness {
  const stdout: string[] = []
  const stderr: string[] = []
  const clock = { now: T0 }
  const width = options.width ?? 80
  const stream = { columns: width, rows: options.rows ?? 40, isTTY: options.mode !== 'plain', write: (text: string) => stderr.push(text) }
  const renderer = createSyncNowRenderer({
    mode: options.mode ?? 'live',
    stdout: { write: (text) => stdout.push(text) },
    stderr: stream,
    presentation: createPresentation({ width, color: options.color === true ? 'always' : 'never' }),
    glyphs: options.glyphs ?? true,
    now: () => clock.now,
    intervalMs: options.intervalMs ?? 100
  })
  return {
    renderer,
    stdout,
    stderr,
    stream,
    clock,
    at(at, event) {
      clock.now = T0 + at
      renderer.onEvent(event)
    }
  }
}

/** Frames written by the live renderer: each is the list of lines after its erase prefix. */
export function liveFrames(writes: readonly string[]): string[][] {
  return writes
    .filter((write) => write.includes('\x1b[?2026h'))
    .map((write) => stripControl(write).replace(/\n$/u, ''))
    .filter((text) => text !== '')
    .map((text) => text.split('\n'))
}

/** Drop cursor/erase/sync sequences, keep SGR colour so callers can still see styles. */
export function stripControl(text: string): string {
  let out = text
  for (const sequence of ['[?25h', '[?25l', '[?2026h', '[?2026l']) {out = out.split(`${ESC}${sequence}`).join('')}
  return out.replace(ERASE, '')
}

const ESC = '\u001b'
/** Cursor-up N lines + clear to end of screen: the live renderer's erase. */
const ERASE = new RegExp(`${ESC}\\[(\\d+)F${ESC}\\[J`, 'gu')

/** Heights (lines moved up) of every erase in one write. */
export function eraseHeights(write: string): number[] {
  return [...write.matchAll(ERASE)].map((match) => Number(match[1]))
}

export const HIDE = `${ESC}[?25l`
export const SHOW = `${ESC}[?25h`

/** Terminal cells of a rendered line: every glyph the renderer emits is one cell wide. */
export function cells(line: string): number {
  return [...stripAnsi(line)].length
}
