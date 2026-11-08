import type { Presentation } from './presentation'
import { formatDuration, oneLine, plural, segWidth, type Seg } from './sync-now-render-format'
import { composeRow, glyphLine, machineStatusWidth, planColumns, spread, type Columns, type GlyphSet } from './sync-now-render-layout'
import { laneRow, machineRow, type BoardRow, type LaneRow, type MachineRow, type NoteRow } from './sync-now-render-rows'
import { isTerminalPhase, lockHolderText, machineStatus, tally, type MachineView, type RunView, type Tally } from './sync-now-render-state'

/**
 * Whole-screen compositions: the live frame (header, machine blocks, footer, kept
 * inside the terminal height) and the static final summary for scrollback.
 */

type Block = { machine: MachineRow; lanes: LaneRow[]; note?: NoteRow; done: boolean }

type Level = { doneNotes: boolean; blanks: boolean; lanes: 'all' | 'active' | 'none'; doneRows: boolean }

/** Ways to shrink a frame for a short terminal, gentlest first. */
const LEVELS: readonly Level[] = [
  { doneNotes: true, blanks: true, lanes: 'all', doneRows: true },
  { doneNotes: false, blanks: true, lanes: 'all', doneRows: true },
  { doneNotes: false, blanks: false, lanes: 'all', doneRows: true },
  { doneNotes: false, blanks: false, lanes: 'active', doneRows: true },
  { doneNotes: false, blanks: false, lanes: 'none', doneRows: true },
  { doneNotes: false, blanks: false, lanes: 'none', doneRows: false }
]

export type FrameInput = {
  presentation: Presentation
  view: RunView
  now: number
  width: number
  maxLines: number
  set: GlyphSet
}

export function liveFrame(input: FrameInput): string[] {
  const { presentation, view, now, width, set } = input
  if (view.plan === undefined) {return view.lockWait === undefined ? [] : [lockWaitLine(input)]}
  if (view.machines.length === 0) {return [spread(presentation, headerSegs(view), [], width, set.ellipsis)]}
  const blocks = view.machines.map((entry) => block(entry, now, set.glyphs))
  // Columns come from every row the plan could show, so they never jump mid-run.
  const columns = planColumns(blocks.flatMap((item) => [item.machine, ...item.lanes]), width, set.glyphs)
  const counts = tally(view)
  const header = spread(presentation, headerSegs(view), [{ text: formatDuration(now - (view.startedAt ?? now)), style: 'muted' }], width, set.ellipsis)
  const hint: Seg[] = counts.running + counts.queued > 0 ? [{ text: 'ctrl-c to stop', style: 'muted' }] : []
  const footer = spread(presentation, tallySegs(counts), hint, width, set.ellipsis, true)
  const global: BoardRow[] = view.globalWarning === undefined ? [] : [{ kind: 'note', text: view.globalWarning }]
  const maxLines = Math.max(1, input.maxLines)
  for (const level of LEVELS) {
    const body = [...blocks.flatMap((item) => blockRows(item, level)), ...global]
    const lines = frameLines(header, footer, body.map((row) => composeRow(presentation, row, columns, set)), level.blanks)
    if (lines.length <= maxLines) {return lines}
  }
  return squeezed(input, blocks, columns, header, footer, maxLines)
}

/** Last resort for tiny terminals: as many running machines as fit, then a count. */
function squeezed(input: FrameInput, blocks: readonly Block[], columns: Columns, header: string, footer: string, maxLines: number): string[] {
  const { presentation, set } = input
  const running = blocks.filter((item) => !item.done)
  const room = Math.max(0, maxLines - 2)
  const shown = running.length <= room ? running : running.slice(0, Math.max(0, room - 1))
  const rest = running.length - shown.length
  const more: string[] = rest > 0 ? [composeRow(presentation, { kind: 'note', text: `+ ${rest} more running`, tone: 'muted' }, columns, set)] : []
  const lines = [header, ...shown.map((item) => composeRow(presentation, item.machine, columns, set)), ...more, footer]
  return lines.slice(0, maxLines)
}

function frameLines(header: string, footer: string, body: readonly string[], blanks: boolean): string[] {
  return blanks ? [header, '', ...body, '', footer] : [header, ...body, footer]
}

function block(entry: MachineView, now: number, glyphs: boolean): Block {
  const status = machineStatus(entry)
  return {
    machine: machineRow(entry, now),
    lanes: entry.lanes.map((lane) => laneRow(lane, now, glyphs)),
    ...(entry.warning === undefined ? {} : { note: { kind: 'note', text: entry.warning } }),
    done: status === 'synced' || status === 'skipped' || status === 'failed'
  }
}

function blockRows(item: Block, level: Level): BoardRow[] {
  if (item.done) {
    if (!level.doneRows) {return []}
    return [item.machine, ...(level.doneNotes && item.note !== undefined ? [item.note] : [])]
  }
  const lanes = level.lanes === 'all' ? item.lanes : item.lanes.filter((lane) => level.lanes === 'active' && lane.active)
  return [item.machine, ...lanes, ...(level.lanes !== 'none' && item.note !== undefined ? [item.note] : [])]
}

function headerSegs(view: RunView): Seg[] {
  const machines = view.machines.length
  const lanes = view.machines.reduce((sum, entry) => sum + entry.lanes.length, 0)
  const scope = machines === 0 ? 'nothing to sync' : `${plural(machines, 'machine')} · ${plural(lanes, 'lane')}`
  return [{ text: 'db sync', style: 'section' }, { text: ` · ${scope}`, style: 'muted' }]
}

export function tallySegs(counts: Tally, interrupted = false): Seg[] {
  const parts: Seg[] = [
    ...(counts.synced > 0 ? [{ text: `${counts.synced} synced`, style: 'success' as const }] : []),
    ...(counts.skipped > 0 ? [{ text: `${counts.skipped} skipped`, style: 'muted' as const }] : []),
    ...(counts.failed > 0 ? [{ text: `${counts.failed} failed`, style: 'error' as const }] : []),
    ...(counts.running > 0 ? [{ text: `${counts.running} running` }] : []),
    ...(counts.queued > 0 ? [{ text: `${counts.queued} queued`, style: 'muted' as const }] : []),
    ...(interrupted ? [{ text: 'interrupted', style: 'warning' as const }] : [])
  ]
  if (parts.length === 0) {return [{ text: 'nothing to sync', style: 'muted' }]}
  return parts.flatMap((part, index) => index === 0 ? [part] : [{ text: ' · ', style: 'muted' as const }, part])
}

function lockWaitLine(input: FrameInput): string {
  const wait = input.view.lockWait!
  const holder = wait.holderStartedAt === undefined ? '' : `, started ${formatDuration(input.now - wait.holderStartedAt)} ago`
  return glyphLine(
    input.presentation,
    'spin',
    input.set,
    [{ text: `waiting for ${lockHolderText(wait.command)} to finish` }, { text: ` (pid ${wait.pid}${holder})`, style: 'muted' }],
    [{ text: formatDuration(input.now - wait.since), style: 'muted' }],
    input.width
  )
}

/** Static final summary: machine rows with final states, notes, then the tally and total time. */
export function summaryLines(presentation: Presentation, view: RunView, now: number, width: number, set: GlyphSet): string[] {
  const result = view.result
  const planned = view.machines.flatMap((entry) => summaryRows(entry, now, set.glyphs))
  const columns = planColumns(planned, width, set.glyphs)
  // Scrollback is where the user reads why a machine was skipped: a reason the row had to drop gets its own line.
  const rows = planned.flatMap((row): BoardRow[] => row.kind === 'machine' && detailDropped(row, machineStatusWidth(columns))
    ? [row, { kind: 'note', text: row.detail!, tone: 'muted' }]
    : [row])
  const counts: Tally = result === undefined
    ? tally(view)
    : { synced: result.syncedCount, skipped: result.skippedCount, failed: result.failedCount, running: 0, queued: 0 }
  const total = result?.elapsedMs ?? now - (view.startedAt ?? now)
  const tallyLine = spread(presentation, tallySegs(counts, result?.interrupted === true), [{ text: formatDuration(total), style: 'muted' }], width, set.ellipsis)
  const body = rows.map((row) => composeRow(presentation, row, columns, set))
  return body.length === 0 ? [tallyLine] : [...body, '', tallyLine]
}

/** True when no status candidate that carries the row's detail fits the status cell. */
function detailDropped(row: MachineRow, statusWidth: number): boolean {
  const detail = row.detail
  if (detail === undefined) {return false}
  return !row.status.some((candidate) => candidate.map((seg) => seg.text).join('').includes(detail) && segWidth(candidate) <= statusWidth)
}

function summaryRows(entry: MachineView, now: number, glyphs: boolean): BoardRow[] {
  const row = machineRow(entry, now)
  const status = machineStatus(entry)
  const machine: MachineRow = status === 'active' || status === 'queued'
    ? { ...row, glyph: 'skipped', status: [[{ text: 'interrupted', style: 'muted' }, { text: ` · was ${entry.phase}`, style: 'muted' }]] }
    : row
  // Scrollback is static: a lane the run left mid-flight says so instead of showing a frozen bar.
  const lanes = entry.lanes.length > 1 && lanesWorthShowing(entry)
    ? entry.lanes.map((lane): LaneRow => isTerminalPhase(lane.phase) || lane.phase === 'queued'
      ? laneRow(lane, now, glyphs)
      : { ...laneRow(lane, now, glyphs), status: [[{ text: `stopped while ${lane.phase}`, style: 'muted' }]] })
    : []
  const warnings = (entry.outcome?.warnings ?? (entry.warning === undefined ? [] : [entry.warning]))
    .map((text): NoteRow => ({ kind: 'note', text: oneLine(text) }))
    .filter((note) => note.text !== '')
  return [machine, ...lanes, ...warnings]
}

/** Lanes earn a line in scrollback only when they disagree or carry trouble. */
function lanesWorthShowing(entry: MachineView): boolean {
  const states = new Set(entry.lanes.map((lane) => lane.phase))
  return states.size > 1 || entry.lanes.some((lane) => (lane.progress?.conflicts ?? 0) > 0 || (lane.progress?.problems ?? 0) > 0 || lane.phase === 'failed')
}
