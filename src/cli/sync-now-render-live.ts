import { visibleWidth } from './presentation'
import type { SyncNowEvent, SyncNowRenderer, SyncNowRendererOptions } from './sync-now-types'
import { liveFrame, summaryLines } from './sync-now-render-board'
import { ellipsisFor } from './sync-now-render-format'
import type { GlyphSet } from './sync-now-render-layout'
import { applySyncEvent, createRunView } from './sync-now-render-state'

/**
 * TTY renderer for `db sync`: a status board redrawn in place on stderr (erase the
 * previous region with cursor-up + clear, like `shell ls`), then a static summary
 * on stdout that stays in scrollback. The cursor is hidden while live and always
 * restored by finish/close (and, as a last resort, on process exit).
 */

const UNICODE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const ASCII_FRAMES = ['-', '\\', '|', '/'] as const

export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'
/** Synchronized output (DEC 2026): terminals that know it paint each frame atomically; others ignore it. */
const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const DEFAULT_ROWS = 24

/** Structural events redraw at once; progress chatter waits for the next tick. */
const IMMEDIATE: ReadonlySet<SyncNowEvent['type']> = new Set(['plan', 'machine-done', 'lock-wait', 'warning'])

export function createLiveSyncRenderer(options: SyncNowRendererOptions): SyncNowRenderer {
  const now = options.now ?? Date.now
  const intervalMs = Math.max(16, options.intervalMs ?? 100)
  const frames: readonly string[] = options.glyphs ? UNICODE_FRAMES : ASCII_FRAMES
  const ellipsis = ellipsisFor(options.glyphs)
  const view = createRunView()
  let frame = 0
  let drawn: number[] = []
  let drawnColumns = 0
  let lastDrawAt = Number.NEGATIVE_INFINITY
  let cursorHidden = false
  let done = false
  let timer: ReturnType<typeof setInterval> | undefined

  const columns = (): number => positive(options.stderr.columns) ?? Math.max(1, options.presentation.width)
  const rows = (): number => positive(options.stderr.rows) ?? DEFAULT_ROWS
  const glyphSet = (): GlyphSet => ({ glyphs: options.glyphs, spinner: frames[frame % frames.length]!, ellipsis })

  /** Cursor-up over what we drew, counting rows a narrowed terminal re-wrapped. */
  const eraseSequence = (): string => {
    if (drawn.length === 0) {return ''}
    const width = columns()
    const height = width < drawnColumns
      ? drawn.reduce((sum, cells) => sum + Math.max(1, Math.ceil(cells / width)), 0)
      : drawn.length
    drawn = []
    return `\x1b[${height}F\x1b[J`
  }

  const restoreOnExit = (): void => {
    if (cursorHidden) {options.stderr.write(SHOW_CURSOR)}
  }

  const draw = (): void => {
    if (done) {return}
    const width = columns()
    const lines = liveFrame({ presentation: options.presentation, view, now: now(), width, maxLines: rows() - 1, set: glyphSet() })
    let out = eraseSequence()
    if (lines.length > 0) {
      if (!cursorHidden) {
        cursorHidden = true
        process.on('exit', restoreOnExit)
        out = `${HIDE_CURSOR}${out}`
      }
      out += `${lines.join('\n')}\n`
      drawn = lines.map(terminalCells)
      drawnColumns = width
    }
    lastDrawAt = now()
    if (out !== '') {options.stderr.write(`${SYNC_BEGIN}${out}${SYNC_END}`)}
  }

  const startTimer = (): void => {
    if (timer !== undefined || done) {return}
    timer = setInterval(() => {
      frame += 1
      draw()
    }, intervalMs)
    timer.unref?.()
  }

  /** Stop the clock, wipe the live region, give the cursor back. */
  const teardown = (): void => {
    if (timer !== undefined) {clearInterval(timer)}
    timer = undefined
    let out = eraseSequence()
    if (cursorHidden) {
      out += SHOW_CURSOR
      cursorHidden = false
    }
    process.off('exit', restoreOnExit)
    if (out !== '') {options.stderr.write(out)}
  }

  return {
    onEvent(event) {
      if (done) {return}
      applySyncEvent(view, event, now())
      if (event.type === 'finished') {
        teardown()
        done = true
        const width = columns()
        const lines = summaryLines(options.presentation, view, now(), width, glyphSet())
        options.stdout.write(`${lines.join('\n')}\n`)
        return
      }
      startTimer()
      if (IMMEDIATE.has(event.type) || now() - lastDrawAt >= intervalMs) {draw()}
    },
    close() {
      if (done) {return}
      done = true
      teardown()
    }
  }
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** Cells a terminal really uses: ✓ and ✗ are one cell even though the shared helper counts two. */
export function terminalCells(line: string): number {
  return visibleWidth(line.replace(/[✓✗]/gu, '-'))
}
