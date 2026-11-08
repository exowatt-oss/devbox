import { describe, expect, it } from 'vitest'
import { createPresentation, stripAnsi } from './presentation'
import {
  fitSegs,
  formatBytes,
  formatCount,
  formatDuration,
  isoSecond,
  middleEllipsis,
  oneLine,
  pathEllipsis,
  padCells,
  percent,
  progressBar
} from './sync-now-render-format'

describe('db sync text helpers', () => {
  it('formats durations as `0.4 s` under ten seconds, then m:ss and h:mm:ss', () => {
    expect([0, 400, 9_999, 10_000, 62_000, 182_300, 3_723_000, -5, Number.NaN].map(formatDuration)).toEqual([
      '0.0 s', '0.4 s', '9.9 s', '0:10', '1:02', '3:02', '1:02:03', '0.0 s', '0.0 s'
    ])
  })

  it('uses thousands separators and decimal byte units', () => {
    expect([0, 999, 1000, 3310, 1_234_567].map(formatCount)).toEqual(['0', '999', '1,000', '3,310', '1,234,567'])
    expect([0, 512, 4_200, 182_000_000, 1_234_000_000, 999_600, 2e15].map(formatBytes)).toEqual([
      '0 B', '512 B', '4.2 KB', '182 MB', '1.2 GB', '1.0 MB', '2000 TB'
    ])
  })

  it('stamps lines in UTC to the second', () => {
    expect(isoSecond(Date.UTC(2026, 9, 12, 18, 22, 31, 987))).toBe('2026-10-12T18:22:31Z')
  })

  it('keeps both ends of long paths and collapses engine text to one printable line', () => {
    expect(middleEllipsis('~/.pi/agent/session-sync', 16, '…')).toBe('~/.pi/…sion-sync')
    expect(middleEllipsis('~/project', 16, '…')).toBe('~/project')
    expect(middleEllipsis('~/.pi/agent/session-sync', 16, '...')).toBe('~/.pi...ion-sync')
    // Paths keep their root and whole trailing components before any mid-word cut.
    expect(pathEllipsis('~/.pi/agent/session-sync', 23, '…')).toBe('~/…/agent/session-sync')
    expect(pathEllipsis('~/.pi/agent/session-sync', 16, '…')).toBe('~/…/session-sync')
    expect(pathEllipsis('/home/alice/project', 12, '…')).toBe('/…/project')
    expect(pathEllipsis('~/.pi/agent/session-sync', 12, '…')).toBe('~/.p…on-sync')
    expect(pathEllipsis('~/project', 16, '…')).toBe('~/project')
    expect(oneLine('  error:\n\tpermission\u001b[31m denied\u0007 ')).toBe('error: permission denied')
  })

  it('picks the richest candidate that fits and never exceeds the cell', () => {
    const presentation = createPresentation({ width: 80, color: 'always' })
    const ladder = [[{ text: 'transferring' }, { text: ' · 36% · 182 MB', style: 'muted' as const }], [{ text: 'transferring' }, { text: ' 36%', style: 'muted' as const }]]
    expect(stripAnsi(fitSegs(presentation, ladder, 40, '…'))).toBe('transferring · 36% · 182 MB')
    expect(stripAnsi(fitSegs(presentation, ladder, 20, '…'))).toBe('transferring 36%')
    expect(stripAnsi(fitSegs(presentation, ladder, 10, '…'))).toBe('transferr…')
    // A cut through a styled segment still closes its colour.
    expect(fitSegs(presentation, [[{ text: 'muted words here', style: 'muted' }]], 6, '…')).toBe('\u001b[2mmuted…\u001b[0m')
    expect(stripAnsi(padCells('abc', 6, '…', 'right'))).toBe('   abc')
  })

  it('draws a bar that is only full when the work is, and never claims 100% early', () => {
    const bar = (fraction: number): string => progressBar(fraction, 10, true).map((seg) => seg.text).join('')
    expect(bar(0)).toBe('──────────')
    expect(bar(0.99)).toBe('━━━━━━━━━─')
    expect(bar(1)).toBe('━━━━━━━━━━')
    expect(progressBar(0.5, 4, false).map((seg) => seg.text).join('')).toBe('==--')
    expect([0, 0.364, 0.999, 1, 2].map(percent)).toEqual(['0%', '36%', '99%', '99%', '99%'])
  })
})
