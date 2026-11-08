import type { SyncNowEvent, SyncNowRenderer, SyncNowRendererOptions } from './sync-now-types'
import { summaryLines, tallySegs } from './sync-now-render-board'
import { ellipsisFor, formatBytes, formatCount, formatDuration, isoSecond, oneLine, paintSegs, percent, plural, type Seg } from './sync-now-render-format'
import { issueSegs, skipText } from './sync-now-render-rows'
import {
  applySyncEvent,
  conflictCounts,
  createRunView,
  findMachine,
  isTerminalPhase,
  lockHolderText,
  machineStatus,
  movedSummary,
  stagingFraction,
  stagingTotals,
  type MachineView
} from './sync-now-render-state'

/**
 * Line-log renderer for `db sync` (non-TTY stderr or --plain, e.g. a launchd log):
 * one UTC-stamped line per meaningful change, no cursor movement, no spinner;
 * transfer progress throttled per machine, a heartbeat for long quiet phases,
 * then a tally line. The aligned summary goes to stdout as the command's result.
 */

/** At most one transfer-progress line per machine this often. */
export const PROGRESS_EVERY_MS = 10_000
/** A machine quiet this long in one phase gets a `still scanning` line. */
export const HEARTBEAT_EVERY_MS = 60_000
/** How often the heartbeat is checked when the engine itself is quiet. */
const HEARTBEAT_CHECK_MS = 5000

export function createPlainSyncRenderer(options: SyncNowRendererOptions): SyncNowRenderer {
  const now = options.now ?? Date.now
  const { presentation } = options
  const view = createRunView()
  const phaseKey = new Map<string, string>()
  const lanePhase = new Map<string, string>()
  const lastLineAt = new Map<string, number>()
  const lastProgressAt = new Map<string, number>()
  const reported = new Set<string>()
  const warned = new Set<string>()
  let lockPid: number | undefined
  let done = false
  let nameWidth = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const write = (segs: readonly Seg[]): void => {
    options.stderr.write(`${isoSecond(now())}  ${paintSegs(presentation, segs)}\n`)
  }
  const machineLine = (entry: MachineView, segs: readonly Seg[]): void => {
    write([{ text: `${entry.machine.name.padEnd(nameWidth)}  ` }, ...segs])
    lastLineAt.set(entry.machine.key, now())
  }

  const onMachinePhase = (entry: MachineView): void => {
    if (isTerminalPhase(entry.phase) || entry.phase === 'queued') {return}
    const key = `${entry.phase}\u0000${entry.detail ?? ''}`
    if (phaseKey.get(entry.machine.key) === key) {return}
    phaseKey.set(entry.machine.key, key)
    if (entry.phase === 'transferring') {lastProgressAt.set(entry.machine.key, now())}
    machineLine(entry, phaseSegs(entry))
  }

  const onLaneProgress = (entry: MachineView, laneKey: string): void => {
    const lane = entry.lanes.find((candidate) => candidate.lane.key === laneKey)
    if (lane !== undefined && entry.lanes.length > 1 && lane.phase !== lanePhase.get(laneKey)) {
      lanePhase.set(laneKey, lane.phase)
      if (lane.phase === 'synced' || lane.phase === 'failed') {
        const error = lane.phase === 'failed' ? oneLine(lane.progress?.lastError) : ''
        machineLine(entry, [{ text: `${lane.lane.label} ${lane.lane.localPath}: ` }, { text: lane.phase, style: lane.phase === 'failed' ? 'error' : 'success' }, ...(error === '' ? [] : [{ text: ` · ${error}` }])])
      }
    }
    const at = now()
    if (entry.phase === 'transferring' && at - (lastProgressAt.get(entry.machine.key) ?? Number.NEGATIVE_INFINITY) >= PROGRESS_EVERY_MS) {
      lastProgressAt.set(entry.machine.key, at)
      machineLine(entry, phaseSegs(entry))
    }
  }

  /** Long scans emit no events worth a line; say `still scanning` once a minute. */
  const heartbeat = (): void => {
    const at = now()
    for (const entry of view.machines) {
      if (machineStatus(entry) !== 'active' || entry.phase === 'transferring') {continue}
      if (at - (lastLineAt.get(entry.machine.key) ?? at) < HEARTBEAT_EVERY_MS) {continue}
      machineLine(entry, [{ text: `still ${entry.phase}` }, { text: ` · ${formatDuration(at - entry.phaseSince)}`, style: 'muted' }])
    }
  }

  const report = (entry: MachineView): void => {
    const outcome = entry.outcome
    if (outcome === undefined || reported.has(entry.machine.key)) {return}
    reported.add(entry.machine.key)
    for (const warning of outcome.warnings) {warn(entry, warning)}
    machineLine(entry, outcomeSegs(entry))
  }

  const warn = (entry: MachineView | undefined, message: string): void => {
    const text = oneLine(message)
    const id = `${entry?.machine.key ?? ''}\u0000${text}`
    if (text === '' || warned.has(id)) {return}
    warned.add(id)
    const segs: Seg[] = [{ text: 'warning: ', style: 'warning' }, { text }]
    if (entry === undefined) {write(segs)} else {machineLine(entry, segs)}
  }

  const handle = (event: SyncNowEvent): void => {
    switch (event.type) {
      case 'lock-wait':
        if (lockPid !== event.holderPid) {write([{ text: `waiting for ${lockHolderText(event.holderCommand)} (pid ${event.holderPid})` }])}
        lockPid = event.holderPid
        return
      case 'plan': {
        nameWidth = Math.max(0, ...view.machines.map((entry) => entry.machine.name.length))
        const lanes = view.machines.reduce((sum, entry) => sum + entry.lanes.length, 0)
        const names = view.machines.map((entry) => entry.machine.name).join(', ')
        write(view.machines.length === 0
          ? [{ text: 'db sync · nothing to sync' }]
          : [{ text: `db sync · ${plural(view.machines.length, 'machine')} (${names}) · ${plural(lanes, 'lane')}` }])
        return
      }
      case 'machine-phase': {
        const entry = findMachine(view, event.machineKey)
        if (entry !== undefined) {onMachinePhase(entry)}
        return
      }
      case 'lane-progress': {
        const entry = findMachine(view, event.machineKey)
        if (entry !== undefined && entry.outcome === undefined) {onLaneProgress(entry, event.laneKey)}
        return
      }
      case 'machine-done': {
        const entry = findMachine(view, event.outcome.machineKey)
        if (entry !== undefined) {report(entry)}
        return
      }
      case 'warning':
        warn(event.machineKey === undefined ? undefined : findMachine(view, event.machineKey), event.message)
        return
      case 'finished': {
        for (const entry of view.machines) {report(entry)}
        const { result } = event
        const counts = { synced: result.syncedCount, skipped: result.skippedCount, failed: result.failedCount, running: 0, queued: 0 }
        write([...tallySegs(counts, result.interrupted), { text: ` in ${formatDuration(result.elapsedMs)}`, style: 'muted' }])
        const set = { glyphs: options.glyphs, spinner: '', ellipsis: ellipsisFor(options.glyphs) }
        options.stdout.write(`${summaryLines(presentation, view, now(), Math.max(20, presentation.width), set).join('\n')}\n`)
      }
    }
  }

  const stop = (): void => {
    done = true
    if (timer !== undefined) {clearInterval(timer)}
    timer = undefined
  }

  return {
    onEvent(event) {
      if (done) {return}
      applySyncEvent(view, event, now())
      handle(event)
      if (event.type === 'finished') {
        stop()
        return
      }
      if (event.type === 'plan' && timer === undefined) {
        timer = setInterval(heartbeat, HEARTBEAT_CHECK_MS)
        timer.unref?.()
      }
      heartbeat()
    },
    close: stop
  }
}

function phaseSegs(entry: MachineView): Seg[] {
  const detail = entry.detail === undefined || entry.detail === '' ? [] : [{ text: ` · ${entry.detail}`, style: 'muted' as const }]
  if (entry.phase !== 'transferring') {return [{ text: entry.phase }, ...detail]}
  const totals = stagingTotals(entry.lanes)
  if (totals === undefined) {return [{ text: 'transferring' }, ...detail]}
  const fraction = stagingFraction(totals)
  const files = totals.expected > 0 ? `${formatCount(totals.received)}/${plural(totals.expected, 'file')}` : plural(totals.received, 'file')
  const bytes = totals.bytes > 0 ? ` · ${formatBytes(totals.bytes)}` : ''
  const share = fraction === undefined ? '' : ` (${percent(fraction)})`
  return [{ text: 'transferring ' }, { text: `${files}${bytes}${share}`, style: 'muted' }]
}

function outcomeSegs(entry: MachineView): Seg[] {
  const outcome = entry.outcome!
  const issues = issueSegs(conflictCounts(entry)).map((seg) => ({ ...seg, text: seg.text.replace(/^ · /u, ', ') }))
  if (outcome.state === 'synced') {
    const moved = movedSummary(entry)
    // Polls can miss a quick transfer, so nothing seen moving is not claimed as `no changes`.
    const what = !moved.changed
      ? ''
      : [moved.files > 0 ? plural(moved.files, 'file') : 'updated', ...(moved.bytes > 0 ? [formatBytes(moved.bytes)] : [])].join(' · ')
    const aside: Seg[] = what === '' && issues.length === 0
      ? []
      : [{ text: ` (${what}` }, ...(what === '' ? issues.map((seg, index) => index === 0 ? { ...seg, text: seg.text.replace(/^, /u, '') } : seg) : issues), { text: ')' }]
    return [{ text: 'synced', style: 'success' }, { text: ` in ${formatDuration(outcome.elapsedMs)}` }, ...aside]
  }
  if (outcome.state === 'skipped') {
    const why = skipText(outcome.reason, outcome.detail)
    return [{ text: 'skipped', style: outcome.reason === 'stalled' || outcome.reason === 'timeout' ? 'warning' : 'muted' }, { text: why === '' ? '' : `: ${why}` }, ...issues]
  }
  const message = oneLine(outcome.detail) || oneLine(entry.lanes.map((lane) => lane.progress?.lastError).find((error) => error !== undefined))
  return [{ text: 'failed', style: 'error' }, { text: ` after ${formatDuration(outcome.elapsedMs)}${message === '' ? '' : `: ${message}`}` }, ...issues]
}
