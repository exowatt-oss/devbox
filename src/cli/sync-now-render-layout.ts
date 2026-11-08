import { visibleWidth, type Presentation } from './presentation'
import { endEllipsis, fitSegs, middleEllipsis, padCells, paintSegs, pathEllipsis, segWidth, type Seg } from './sync-now-render-format'
import type { BoardRow, GlyphKind, LaneRow, MachineRow } from './sync-now-render-rows'

/**
 * Column grid for the `db sync` board. Machine rows and lane rows share one status
 * column, elapsed is right-aligned to the terminal edge, and every composed line
 * is exactly as wide as it claims: never wider than `width`.
 *
 *   ⠹ devbox   i-0f3a9c2e71b4d5a68        transferring · 38% · 196 MB    2:27
 *       workspace     ~/project           ━━━━────────  1,273/3,310 files
 *   ✓ macmini  exampleuser@192.0.2.12  synced                         4.1 s
 *
 * When the status column is too narrow, the side pushing it right gives way:
 * endpoint/path shorten (keeping both ends), then drop, then names shorten.
 */

export type Columns = {
  width: number
  glyphW: number
  nameW: number
  endpointW: number
  labelW: number
  pathW: number
  statusX: number
  elapsedW: number
}

export type GlyphSet = {
  glyphs: boolean
  spinner: string
  ellipsis: string
}

const GAP = 2
const MIN_ENDPOINT = 16
const MIN_PATH = 12

export function glyphWidth(glyphs: boolean): number {
  return glyphs ? 1 : 4
}

export function planColumns(rows: readonly BoardRow[], width: number, glyphs: boolean): Columns {
  const machines = rows.filter((row): row is MachineRow => row.kind === 'machine')
  const lanes = rows.filter((row): row is LaneRow => row.kind === 'lane')
  const glyphW = glyphWidth(glyphs)
  const widest = (values: readonly string[]): number => Math.max(0, ...values.map((value) => visibleWidth(value)))
  const columns: Columns = {
    width,
    glyphW,
    nameW: Math.min(16, widest(machines.map((row) => row.name))),
    endpointW: Math.min(34, widest(machines.map((row) => row.endpoint))),
    labelW: Math.min(14, widest(lanes.map((row) => row.label))),
    pathW: Math.min(30, widest(lanes.map((row) => row.path))),
    statusX: 0,
    elapsedW: Math.max(5, widest(machines.map((row) => row.elapsed))),
  }
  const target = Math.min(48, Math.max(16, Math.floor(width * 0.44)))
  while (width - statusStart(columns) - GAP - columns.elapsedW < target) {
    if (!shrinkOnce(columns)) {break}
  }
  columns.statusX = statusStart(columns)
  return columns
}

function shrinkOnce(columns: Columns): boolean {
  if (laneLeft(columns) >= machineLeft(columns)) {
    if (columns.pathW > MIN_PATH) {columns.pathW -= 1}
    else if (columns.pathW > 0) {columns.pathW = 0}
    else if (columns.labelW > 8) {columns.labelW -= 1}
    else {return machineLeft(columns) === laneLeft(columns) && shrinkMachine(columns)}
    return true
  }
  return shrinkMachine(columns)
}

function shrinkMachine(columns: Columns): boolean {
  if (columns.endpointW > MIN_ENDPOINT) {columns.endpointW -= 1}
  else if (columns.endpointW > 0) {columns.endpointW = 0}
  else if (columns.nameW > 8) {columns.nameW -= 1}
  else {return false}
  return true
}

function machineLeft(columns: Columns): number {
  return columns.glyphW + 1 + columns.nameW + (columns.endpointW > 0 ? GAP + columns.endpointW : 0)
}

function laneLeft(columns: Columns): number {
  return columns.labelW > 0 ? laneIndent(columns) + columns.labelW + (columns.pathW > 0 ? GAP + columns.pathW : 0) : 0
}

function statusStart(columns: Columns): number {
  return Math.max(machineLeft(columns), laneLeft(columns)) + GAP
}

function laneIndent(columns: Columns): number {
  return columns.glyphW + 3
}

export function glyphCell(presentation: Presentation, kind: GlyphKind, set: GlyphSet): string {
  const [text, style] = glyphText(kind, set)
  return presentation.style(text.padEnd(glyphWidth(set.glyphs)), style)
}

function glyphText(kind: GlyphKind, set: GlyphSet): [string, 'info' | 'muted' | 'success' | 'warning' | 'error'] {
  switch (kind) {
    case 'spin': return [set.spinner, 'info']
    case 'queued': return [set.glyphs ? '·' : '..', 'muted']
    case 'synced': return [set.glyphs ? '✓' : 'ok', 'success']
    case 'skipped': return [set.glyphs ? '○' : 'skip', 'muted']
    case 'skipped-warn': return [set.glyphs ? '○' : 'skip', 'warning']
    case 'failed': return [set.glyphs ? '✗' : 'fail', 'error']
  }
}

/**
 * One composed line. The glyph cell is kept apart from the measured text because
 * the shared width helper counts ✓/✗ as two cells while terminals draw one.
 */
export function composeRow(presentation: Presentation, row: BoardRow, columns: Columns, set: GlyphSet): string {
  if (row.kind === 'machine') {return composeMachine(presentation, row, columns, set)}
  const indent = ' '.repeat(laneIndent(columns))
  const room = Math.max(0, columns.width - indent.length)
  if (row.kind === 'note') {
    const body = row.tone === 'muted'
      ? [{ text: row.text, style: 'muted' as const }]
      : [{ text: '! ', style: 'warning' as const }, { text: row.text, style: 'muted' as const }]
    return clampRight(`${indent}${fitSegs(presentation, [body], room, set.ellipsis)}`, columns.width, set.ellipsis)
  }
  const label = padCells(presentation.style(endEllipsis(row.label, columns.labelW, set.ellipsis), 'muted'), columns.labelW, set.ellipsis)
  const path = columns.pathW > 0
    ? `${' '.repeat(GAP)}${padCells(presentation.style(pathEllipsis(row.path, columns.pathW, set.ellipsis), 'muted'), columns.pathW, set.ellipsis)}`
    : ''
  const head = padCells(`${indent}${label}${path}`, columns.statusX, set.ellipsis)
  const status = fitSegs(presentation, row.status, Math.max(0, columns.width - columns.statusX), set.ellipsis)
  return clampRight(`${head}${status}`.trimEnd(), columns.width, set.ellipsis)
}

function composeMachine(presentation: Presentation, row: MachineRow, columns: Columns, set: GlyphSet): string {
  const name = padCells(endEllipsis(row.name, columns.nameW, set.ellipsis), columns.nameW, set.ellipsis)
  const endpoint = columns.endpointW > 0
    ? `${' '.repeat(GAP)}${padCells(presentation.style(shortEndpoint(row.endpoint, columns.endpointW, set.ellipsis), 'muted'), columns.endpointW, set.ellipsis)}`
    : ''
  const restWidth = columns.width - columns.glyphW
  if (restWidth < 2) {return clampRight(row.name, columns.width, set.ellipsis)}
  const head = padCells(` ${name}${endpoint}`, columns.statusX - columns.glyphW, set.ellipsis)
  const statusW = machineStatusWidth(columns)
  const status = padCells(fitSegs(presentation, row.status, statusW, set.ellipsis), statusW, set.ellipsis)
  const elapsed = row.elapsed === '' ? '' : presentation.style(row.elapsed.padStart(columns.elapsedW), 'muted')
  const rest = clampRight(`${head}${status}${' '.repeat(GAP)}${elapsed}`.trimEnd(), restWidth, set.ellipsis)
  return `${glyphCell(presentation, row.glyph, set)}${rest}`
}

/** Cells the status of a machine row gets between the head columns and the elapsed column. */
export function machineStatusWidth(columns: Columns): number {
  return Math.max(0, columns.width - columns.statusX - GAP - columns.elapsedW)
}

/**
 * `left ……… right` across the full width. The left side yields first, unless the
 * right side is `optional` (a hint), which is dropped rather than squeeze the left.
 */
export function spread(presentation: Presentation, left: readonly Seg[], right: readonly Seg[], width: number, ellipsis: string, optional = false): string {
  const rightWidth = segWidth(right)
  const crowded = optional && segWidth(left) + GAP + rightWidth > width
  if (crowded || rightWidth === 0 || rightWidth + GAP + 4 > width) {return fitSegs(presentation, [left], width, ellipsis)}
  const leftRoom = width - rightWidth - GAP
  const leftText = fitSegs(presentation, [left], leftRoom, ellipsis)
  const fill = ' '.repeat(Math.max(GAP, width - visibleWidth(leftText) - rightWidth))
  return `${leftText}${fill}${paintSegs(presentation, right)}`
}

/** A spinner (or glyph) cell followed by text and a right-aligned value, e.g. the lock-wait line. */
export function glyphLine(presentation: Presentation, kind: GlyphKind, set: GlyphSet, text: readonly Seg[], right: readonly Seg[], width: number): string {
  const glyphW = glyphWidth(set.glyphs)
  if (width <= glyphW + 1) {return clampRight(fitSegs(presentation, [text], width, set.ellipsis), width, set.ellipsis)}
  return `${glyphCell(presentation, kind, set)} ${spread(presentation, text, right, width - glyphW - 1, set.ellipsis)}`
}

/** `user@host` that does not fit loses the user first (the host is the identity), then its middle. */
function shortEndpoint(endpoint: string, width: number, ellipsis: string): string {
  if (visibleWidth(endpoint) <= width) {return endpoint}
  const host = endpoint.slice(endpoint.lastIndexOf('@') + 1)
  return middleEllipsis(host, width, ellipsis)
}

/** Last line of defence: nothing measured leaves wider than `width`. */
export function clampRight(text: string, width: number, ellipsis: string): string {
  return visibleWidth(text) > width ? padCells(text, width, ellipsis).trimEnd() : text
}
