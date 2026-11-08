import type { SyncPhase, SyncSkipReason } from './sync-now-types'
import {
  formatBytes,
  formatCount,
  formatDuration,
  oneLine,
  percent,
  plural,
  progressBar,
  type Seg
} from './sync-now-render-format'
import {
  conflictCounts,
  machineElapsed,
  machineStatus,
  movedSummary,
  stagingFraction,
  stagingTotals,
  type LaneView,
  type MachineView
} from './sync-now-render-state'

/**
 * Width-agnostic row content for the `db sync` board. Every status is a ladder of
 * candidates, richest first; the layout picks the first one that fits the cell.
 */

export type GlyphKind = 'spin' | 'queued' | 'synced' | 'skipped' | 'skipped-warn' | 'failed'

export type MachineRow = {
  kind: 'machine'
  key: string
  glyph: GlyphKind
  name: string
  endpoint: string
  status: Seg[][]
  elapsed: string
  /** Why a machine was skipped or failed; the summary gives it its own line when the row cannot hold it. */
  detail?: string
}

/** `active` lanes are mid-flight (not queued, not finished); they survive height pressure longest. */
export type LaneRow = { kind: 'lane'; label: string; path: string; status: Seg[][]; active: boolean }

/** A line under a machine: a warning (`! …`) or a muted aside. */
export type NoteRow = { kind: 'note'; text: string; tone?: 'warning' | 'muted' }

export type BoardRow = MachineRow | LaneRow | NoteRow

const WARN_REASONS: ReadonlySet<SyncSkipReason> = new Set(['stalled', 'timeout'])
/** Below this, a phase timer is noise rather than information. */
const PHASE_CLOCK_MS = 3000

export function endpointText(entry: MachineView): string {
  const { user, host, port } = entry.machine
  return `${user === '' ? '' : `${user}@`}${host}${port === 22 || port === 0 ? '' : `:${port}`}`
}

export function machineGlyph(entry: MachineView): GlyphKind {
  const status = machineStatus(entry)
  if (status === 'active') {return 'spin'}
  if (status === 'skipped') {
    const reason = entry.outcome?.reason
    return reason !== undefined && WARN_REASONS.has(reason) ? 'skipped-warn' : 'skipped'
  }
  return status
}

export function machineRow(entry: MachineView, now: number): MachineRow {
  const status = machineStatus(entry)
  const detail = status === 'skipped' || status === 'failed' ? doneDetail(entry) : ''
  return {
    ...(detail === '' ? {} : { detail }),
    kind: 'machine',
    key: entry.machine.key,
    glyph: machineGlyph(entry),
    name: oneLine(entry.machine.name),
    endpoint: oneLine(endpointText(entry)),
    status: status === 'active' || status === 'queued' ? activeMachineStatus(entry, now) : doneMachineStatus(entry),
    elapsed: status === 'queued' ? '' : formatDuration(machineElapsed(entry, now))
  }
}

export function laneRow(lane: LaneView, now: number, glyphs: boolean): LaneRow {
  return {
    kind: 'lane',
    label: oneLine(lane.lane.label),
    path: oneLine(lane.lane.localPath),
    status: laneStatus(lane, now, glyphs),
    active: lane.phase !== 'queued' && lane.phase !== 'synced' && lane.phase !== 'skipped' && lane.phase !== 'failed'
  }
}

function activeMachineStatus(entry: MachineView, now: number): Seg[][] {
  const word: Seg = { text: entry.phase, style: entry.phase === 'queued' ? 'muted' : undefined }
  const tail = issueSegs(conflictCounts(entry))
  if (entry.phase === 'transferring') {
    const totals = stagingTotals(entry.lanes)
    const fraction = totals === undefined ? undefined : stagingFraction(totals)
    const pct: Seg[] = fraction === undefined ? [] : [muted(` · ${percent(fraction)}`)]
    const bytes: Seg[] = totals === undefined || totals.bytes <= 0 ? [] : [muted(` · ${formatBytes(totals.bytes)}`)]
    const files: Seg[] = totals === undefined || totals.expected <= 0
      ? []
      : [muted(` · ${formatCount(totals.received)}/${plural(totals.expected, 'file')}`)]
    const tight: Seg[] = fraction === undefined ? [] : [muted(` ${percent(fraction)}`)]
    return ladder([word, ...pct, ...files, ...bytes, ...tail], [word, ...pct, ...bytes, ...tail], [word, ...pct, ...tail], [word, ...pct], [word, ...tight], [word])
  }
  const cue = phaseCue(entry.phase, entry.detail, now - entry.phaseSince)
  return ladder([word, ...cue, ...tail], [word, ...cue], [word])
}

function doneMachineStatus(entry: MachineView): Seg[][] {
  const status = machineStatus(entry)
  const outcome = entry.outcome
  const tail = issueSegs(conflictCounts(entry))
  if (status === 'synced') {
    const moved = movedSummary(entry)
    const word: Seg = { text: 'synced', style: 'success' }
    // Polls can miss a quick transfer entirely, so an unseen one is not claimed as `no changes`.
    if (!moved.changed) {return ladder([word, ...tail], [word])}
    const files: Seg[] = moved.files > 0 ? [muted(` · ${plural(moved.files, 'file')}`)] : [muted(' · updated')]
    const bytes: Seg[] = moved.bytes > 0 ? [muted(` · ${formatBytes(moved.bytes)}`)] : []
    return ladder([word, ...files, ...bytes, ...tail], [word, ...files, ...tail], [word, ...tail], [word])
  }
  if (status === 'skipped') {
    const style = machineGlyph(entry) === 'skipped-warn' ? 'warning' : 'muted'
    const word: Seg = { text: 'skipped', style }
    const why = skipText(outcome?.reason, outcome?.detail ?? entry.detail)
    const detail: Seg[] = why === '' ? [] : [{ text: ` · ${why}`, style }]
    const reason: Seg[] = outcome?.reason === undefined ? [] : [{ text: ` · ${outcome.reason}`, style }]
    return ladder([word, ...detail, ...tail], [word, ...detail], [word, ...reason, ...tail], [word, ...reason], [word, ...detail])
  }
  const message = oneLine(outcome?.detail ?? entry.detail ?? firstLaneError(entry))
  const detail: Seg[] = message === '' ? [] : [{ text: ` · ${message}` }]
  return ladder([{ text: 'failed', style: 'error' }, ...tail, ...detail])
}

function doneDetail(entry: MachineView): string {
  const outcome = entry.outcome
  if (machineStatus(entry) === 'failed') {return oneLine(outcome?.detail ?? entry.detail ?? firstLaneError(entry))}
  const detail = oneLine(outcome?.detail ?? entry.detail)
  return detail === '' || detail.toLowerCase() === outcome?.reason ? '' : detail
}

function laneStatus(lane: LaneView, now: number, glyphs: boolean): Seg[][] {
  const progress = lane.progress
  const tail = issueSegs({ conflicts: progress?.conflicts ?? 0, problems: progress?.problems ?? 0 })
  const staging = progress?.staging
  if (lane.phase === 'transferring' && staging !== undefined) {
    const totals = { received: staging.receivedFiles, expected: staging.expectedFiles, bytes: staging.receivedBytes, expectedBytes: staging.expectedBytes }
    const fraction = stagingFraction(totals) ?? 0
    const files = staging.expectedFiles > 0
      ? `${formatCount(staging.receivedFiles)}/${formatCount(staging.expectedFiles)}`
      : formatCount(staging.receivedFiles)
    const bytes = staging.receivedBytes > 0 ? ` · ${formatBytes(staging.receivedBytes)}` : ''
    const total = staging.expectedBytes !== undefined && staging.expectedBytes > 0 ? ` of ${formatBytes(staging.expectedBytes)}` : ''
    // Conflicts also show on the machine row and as a note, so the bar outranks them here.
    return ladder(
      [...progressBar(fraction, 12, glyphs), muted(`  ${files} files${bytes}${total}`), ...tail],
      [...progressBar(fraction, 12, glyphs), muted(`  ${files} files${bytes}`), ...tail],
      [...progressBar(fraction, 12, glyphs), muted(`  ${files} files${bytes}`)],
      [...progressBar(fraction, 8, glyphs), muted(`  ${files}${bytes}`)],
      [...progressBar(fraction, 8, glyphs), muted(`  ${files}`)],
      [muted(`${files}${bytes}`)],
      [muted(percent(fraction))]
    )
  }
  if (lane.phase === 'failed') {
    const message = oneLine(progress?.lastError)
    return ladder([{ text: 'failed', style: 'error' }, ...tail, ...(message === '' ? [] : [muted(` · ${message}`)])])
  }
  if (lane.phase === 'synced') {
    const moved: Seg[] = lane.sawTransfer
      ? [muted(lane.movedFiles > 0 ? ` · ${plural(lane.movedFiles, 'file')}` : ' · updated')]
      : []
    return ladder([muted('synced'), ...moved, ...tail], [muted('synced'), ...tail])
  }
  // The tree's file count; next to `transferring` it would read as the number being sent.
  const files: Seg[] = progress?.files === undefined || lane.phase === 'transferring' ? [] : [muted(` · ${plural(progress.files, 'file')}`)]
  const cue = lane.phase === 'queued' ? [] : phaseCue(lane.phase, undefined, now - lane.phaseSince)
  const error = oneLine(progress?.lastError)
  const last: Seg[] = error === '' ? [] : [{ text: ` · ${error}`, style: 'warning' }]
  return ladder([muted(lane.phase), ...cue, ...files, ...tail, ...last], [muted(lane.phase), ...cue, ...tail], [muted(lane.phase)])
}

/** ` · <detail>` when the engine gave one, else ` · 0:58` once a phase has lasted a while. */
function phaseCue(phase: SyncPhase, detail: string | undefined, phaseMs: number): Seg[] {
  if (detail !== undefined && detail !== '') {return [muted(` · ${detail}`)]}
  if (phase === 'queued' || phaseMs < PHASE_CLOCK_MS) {return []}
  return [muted(` · ${formatDuration(phaseMs)}`)]
}

export function skipText(reason: SyncSkipReason | undefined, detail: string | undefined): string {
  const text = oneLine(detail)
  if (reason === undefined) {return text}
  if (text === '') {return reason}
  return text.toLowerCase().startsWith(reason) ? text : `${reason} (${text})`
}

export function issueSegs(counts: { conflicts: number; problems: number }): Seg[] {
  return [
    ...(counts.conflicts > 0 ? [{ text: ` · ${plural(counts.conflicts, 'conflict')}`, style: 'warning' as const }] : []),
    ...(counts.problems > 0 ? [{ text: ` · ${plural(counts.problems, 'problem')}`, style: 'warning' as const }] : [])
  ]
}

function firstLaneError(entry: MachineView): string | undefined {
  return entry.lanes.map((lane) => lane.progress?.lastError).find((error) => error !== undefined && error !== '')
}

function muted(text: string): Seg {
  return { text, style: 'muted' }
}

/** Candidates richest-first, with exact duplicates removed. */
function ladder(...candidates: Seg[][]): Seg[][] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const id = candidate.map((seg) => seg.text).join('\u0000')
    if (seen.has(id)) {return false}
    seen.add(id)
    return true
  })
}
