import { stripAnsi, truncateText, visibleWidth, type Presentation, type SemanticStyle } from './presentation'

/**
 * Small, pure text helpers for the `db sync` renderers: durations, counts, byte
 * units, ellipses and styled segments. Nothing here knows about terminals.
 */

/** A run of text with one optional semantic style; rows are built from these. */
export type Seg = { text: string; style?: SemanticStyle }

/** `0.4 s` under ten seconds, then `m:ss`, then `h:mm:ss`. Truncates, never rounds up. */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (safe < 10_000) {return `${(Math.floor(safe / 100) / 10).toFixed(1)} s`}
  const total = Math.floor(safe / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Thousands separators without depending on the process locale. */
export function formatCount(value: number): string {
  const whole = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Decimal byte units: `512 B`, `4.2 KB`, `182 MB`, `1.2 GB`. */
export function formatBytes(value: number): string {
  let amount = Math.max(0, Number.isFinite(value) ? value : 0)
  let unit = 0
  while (amount >= 999.5 && unit < BYTE_UNITS.length - 1) {
    amount /= 1000
    unit += 1
  }
  if (unit === 0) {return `${Math.round(amount)} B`}
  return `${amount < 9.95 ? amount.toFixed(1) : String(Math.round(amount))} ${BYTE_UNITS[unit]}`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`
}

/** `2026-10-12T18:22:31Z`: UTC, second precision, sortable, launchd-log friendly. */
export function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

/** Engine-supplied text (Mutagen errors, hook output) collapsed to one printable line. */
export function oneLine(text: string | undefined): string {
  if (text === undefined) {return ''}
  const printable = [...stripAnsi(text)].map((char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  }).join('')
  return printable.replace(/\s+/gu, ' ').trim()
}

export function ellipsisFor(glyphs: boolean): string {
  return glyphs ? '…' : '...'
}

/** Keep both ends of a path: `~/.pi/agent/session-sync` → `~/.pi/…session-sync`. */
export function middleEllipsis(text: string, max: number, ellipsis: string): string {
  const limit = Math.max(0, Math.floor(max))
  if (visibleWidth(text) <= limit) {return text}
  const room = limit - ellipsis.length
  if (room < 2) {return truncateText(text, limit, '')}
  const chars = [...text]
  const head = Math.max(1, Math.floor(room * 0.4))
  const tail = room - head
  return `${chars.slice(0, head).join('')}${ellipsis}${chars.slice(chars.length - tail).join('')}`
}

/**
 * A path that does not fit keeps its root and as many whole trailing components as fit
 * (`~/…/session-sync`), else falls back to a middle cut.
 */
export function pathEllipsis(path: string, max: number, ellipsis: string): string {
  if (visibleWidth(path) <= max) {return path}
  const parts = path.split('/')
  for (let start = 2; start < parts.length; start += 1) {
    const candidate = `${parts[0]}/${ellipsis}/${parts.slice(start).join('/')}`
    if (visibleWidth(candidate) <= max) {return candidate}
  }
  return middleEllipsis(path, max, ellipsis)
}

export function endEllipsis(text: string, max: number, ellipsis: string): string {
  return truncateText(text, max, ellipsis)
}

export function segWidth(segs: readonly Seg[]): number {
  return segs.reduce((sum, seg) => sum + visibleWidth(seg.text), 0)
}

export function paintSegs(presentation: Presentation, segs: readonly Seg[]): string {
  return segs.map((seg) => seg.style === undefined ? seg.text : presentation.style(seg.text, seg.style)).join('')
}

/** Plain text of segments, for line logs. */
export function plainSegs(segs: readonly Seg[]): string {
  return segs.map((seg) => seg.text).join('')
}

/**
 * Pick the richest candidate that fits `width`; when none fits, end-truncate the
 * leanest. Segment styles survive truncation (ANSI-safe), and the result never
 * exceeds `width` cells.
 */
export function fitSegs(
  presentation: Presentation,
  candidates: readonly (readonly Seg[])[],
  width: number,
  ellipsis: string
): string {
  if (width <= 0 || candidates.length === 0) {return ''}
  const fitting = candidates.find((candidate) => segWidth(candidate) <= width)
  if (fitting !== undefined) {return paintSegs(presentation, fitting)}
  return truncateText(paintSegs(presentation, candidates.at(-1)!), width, ellipsis)
}

/** Pad (or end-truncate) already-styled text to exactly `width` cells. */
export function padCells(text: string, width: number, ellipsis: string, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) {return ''}
  const fitted = visibleWidth(text) > width ? truncateText(text, width, ellipsis) : text
  const gap = ' '.repeat(Math.max(0, width - visibleWidth(fitted)))
  return align === 'left' ? `${fitted}${gap}` : `${gap}${fitted}`
}

/** A slim bar: `━━━━━━──────` (or `======------`); fraction is clamped to [0, 1]. */
export function progressBar(fraction: number, width: number, glyphs: boolean): Seg[] {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  // Floor, so the bar is only ever full when the work is.
  const filled = Math.floor(clamped * width)
  const [full, empty] = glyphs ? ['━', '─'] : ['=', '-']
  return [
    { text: full.repeat(filled), style: 'info' },
    { text: empty.repeat(width - filled), style: 'muted' }
  ]
}

export function percent(fraction: number): string {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  // Never claim 100% before the lane actually finishes.
  return `${Math.min(99, Math.floor(clamped * 100))}%`
}
