import { describe, expect, it } from 'vitest'
import {
  ANSI_STYLES,
  colorEnabled,
  createPresentation,
  getTerminalWidth,
  padText,
  renderEmptyState,
  renderKeyValue,
  renderStatus,
  renderTable,
  styleText,
  stripAnsi,
  truncateText,
  unicodeEnabled,
  visibleWidth,
  wrapText
} from './presentation'

describe('Devbox CLI presentation foundation', () => {
  it('keeps automatic colour conservative while allowing explicit force', () => {
    expect(colorEnabled({ env: { TERM: 'xterm-256color' }, isTTY: false })).toBe(false)
    expect(colorEnabled({ env: { TERM: 'xterm-256color' }, isTTY: true })).toBe(true)
    expect(colorEnabled({ env: { NO_COLOR: '', TERM: 'xterm' }, isTTY: true })).toBe(false)
    expect(colorEnabled({ env: { TERM: 'dumb', FORCE_COLOR: '1' }, isTTY: false })).toBe(true)
    expect(colorEnabled({ env: { TERM: 'xterm', FORCE_COLOR: '0' }, isTTY: true })).toBe(false)
    expect(styleText('ready', 'success', { env: {}, isTTY: false })).toBe('ready')
    expect(styleText('ready', 'success', { env: {}, isTTY: true })).toBe(`${ANSI_STYLES.success}ready${ANSI_STYLES.reset}`)
  })

  it('uses injectable width sources in deterministic priority order', () => {
    expect(getTerminalWidth({ width: 91, columns: 72, env: { COLUMNS: '61' } })).toBe(91)
    expect(getTerminalWidth({ columns: 72, env: { COLUMNS: '61' } })).toBe(72)
    expect(getTerminalWidth({ env: { COLUMNS: '61' } })).toBe(61)
    expect(getTerminalWidth({ env: { COLUMNS: 'not-a-width' } })).toBe(80)
    expect(getTerminalWidth({ env: { COLUMNS: '0' } })).toBe(80)
  })

  it('measures ANSI and common Unicode graphemes by display cells', () => {
    const styled = `${ANSI_STYLES.info}café${ANSI_STYLES.reset}`
    expect(stripAnsi(styled)).toBe('café')
    expect(visibleWidth(styled)).toBe(4)
    expect(visibleWidth('e\u0301')).toBe(1)
    expect(visibleWidth('界')).toBe(2)
    expect(visibleWidth('👨‍👩‍👧‍👦')).toBe(2)
    expect(visibleWidth('🇺🇸')).toBe(2)
    expect(visibleWidth('a\tb', 4)).toBe(6)
  })

  it('truncates at grapheme boundaries and closes a truncated style', () => {
    expect(truncateText('alpha', 4)).toBe('alp…')
    expect(truncateText('界界', 3)).toBe('界…')
    expect(truncateText('👨‍👩‍👧‍👦x', 2)).toBe('…')

    const styled = `${ANSI_STYLES.warning}abcdef${ANSI_STYLES.reset}`
    const truncated = truncateText(styled, 4)
    expect(stripAnsi(truncated)).toBe('abc…')
    expect(visibleWidth(truncated)).toBe(4)
    expect(truncated.endsWith(ANSI_STYLES.reset)).toBe(true)
    expect(padText('界', 4, 'right')).toBe('  界')
    expect(padText('x', 4, 'center')).toBe(' x  ')
  })

  it('keeps important columns and drops lower-priority optional columns at narrow widths', () => {
    const table = renderTable({
      width: 20,
      rows: [
        { id: 'a1', name: 'alpha', status: 'ready', details: 'long detail value' },
        { id: 'b2', name: 'beta', status: 'paused', details: 'another detail' }
      ],
      columns: [
        { key: 'id', header: 'ID' },
        { key: 'name', header: 'NAME', priority: 2 },
        { key: 'status', header: 'STATUS', optional: true, priority: 8 },
        { key: 'details', header: 'DETAILS', optional: true, priority: 1 }
      ]
    })

    expect(table).toContain('ID')
    expect(table).toContain('NAME')
    expect(table).toContain('STATUS')
    expect(table).not.toContain('DETAILS')
    expect(table.split('\n').every((line) => !/\s$/u.test(line))).toBe(true)
    expect(table.split('\n').every((line) => visibleWidth(line) <= 20)).toBe(true)
    expect(table).toBe([
      'ID   NAME    STATUS',
      '--   -----   ------',
      'a1   alpha   ready',
      'b2   beta    paused'
    ].join('\n'))
    expect(table).not.toMatch(/[|+]/u)
  })

  it('retains alignment for wide values without emitting trailing spaces', () => {
    const table = renderTable({
      width: 24,
      rows: [{ name: 'a', count: 12 }, { name: 'long', count: 3 }],
      columns: [
        { key: 'name', header: 'NAME' },
        { key: 'count', header: 'COUNT', align: 'right' }
      ]
    })
    const lines = table.split('\n')
    expect(lines.every((line) => !/\s$/u.test(line))).toBe(true)
    expect(lines[0]).toContain('NAME')
    expect(lines[2]).toBe('a         12')
    expect(lines[3]).toBe('long       3')
    expect(table).not.toMatch(/[|+]/u)
  })

  it('checks exact whitespace alignment across terminal widths', () => {
    for (const width of [60, 80, 100, 120]) {
      const table = renderTable({
        width,
        rows: [{ id: 'profile-roam', user: 'sample', host: 'devbox.example' }],
        columns: [
          { key: 'id', header: 'ID' },
          { key: 'user', header: 'USER' },
          { key: 'host', header: 'HOST' }
        ],
        gap: 2
      })
      const lines = table.split('\n')
      expect(lines).toEqual([
        `ID${' '.repeat(12)}USER${' '.repeat(4)}HOST`,
        `${'-'.repeat(12)}  ${'-'.repeat(6)}  ${'-'.repeat(14)}`,
        'profile-roam  sample  devbox.example'
      ])
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
      expect(lines.every((line) => !/[|+]/u.test(line))).toBe(true)
      expect(lines.every((line) => !line.endsWith(' '))).toBe(true)
    }
  })

  it('provides plain, composable title, section, key-value, status, and empty helpers', () => {
    const plain = { env: { LANG: 'C', TERM: 'dumb' }, isTTY: false, unicode: false }
    expect(styleText('Title', 'title', plain)).toBe('Title')
    expect(renderKeyValue({ profile: 'local', retries: 2, missing: null }, plain)).toBe('profile: local\nretries: 2\nmissing: -')
    expect(renderKeyValue({ profile: 'roam', generationId: 'g1' }, plain)).toBe('profile     : roam\ngenerationId: g1')
    expect(renderStatus('success', 'Ready', plain)).toBe('[ok] Ready')
    expect(renderEmptyState('Nothing to show.', plain)).toBe('- Nothing to show.')

    const presentation = createPresentation({ ...plain, width: 40 })
    expect(presentation.color).toBe(false)
    expect(presentation.width).toBe(40)
    expect(presentation.title('Devbox')).toBe('Devbox')
    expect(presentation.section('Status')).toBe('Status')
    expect(presentation.emptyState()).toBe('- No items found.')
  })

  it('wraps long statuses and aligned values at terminal widths without losing style', () => {
    const message = 'remote failure while synchronizing the very long repository path safely'
    for (const width of [60, 80]) {
      const status = renderStatus('error', message, {
        width,
        color: 'always',
        env: { TERM: 'xterm-256color' },
        isTTY: true,
        unicode: false
      })
      const lines = status.split('\n')
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
      expect(stripAnsi(lines[0]!)).toMatch(/^\[error\] /u)
      if (lines.length > 1) {
        expect(stripAnsi(lines[1]!)).toMatch(/^        /u)
      }
      expect(stripAnsi(status).replace(/\s+/gu, ' ')).toContain(message)
      expect(status).toContain(ANSI_STYLES.error)

      const keyValue = renderKeyValue({ error: message }, {
        width,
        color: 'always',
        env: { TERM: 'xterm-256color' },
        isTTY: true
      })
      expect(keyValue.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
      expect(stripAnsi(keyValue).replace(/\s+/gu, ' ')).toContain(message)
    }
  })

  it('wraps ANSI text at word and grapheme boundaries without truncation', () => {
    const value = `${ANSI_STYLES.warning}alpha beta gamma 👨‍👩‍👧‍👦 delta${ANSI_STYLES.reset}`
    const lines = wrapText(value, 12, { preserveIndent: false })
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true)
    expect(stripAnsi(lines.join('\n')).replace(/\s+/gu, ' ').trim()).toBe('alpha beta gamma 👨‍👩‍👧‍👦 delta')
    expect(lines.every((line) => line.includes(ANSI_STYLES.warning))).toBe(true)

    const hard = wrapText('abcdefghijk', 4, { preserveIndent: false })
    expect(hard.join('')).toBe('abcdefghijk')
    expect(hard.every((line) => visibleWidth(line) <= 4)).toBe(true)
  })

  it('only uses Unicode status symbols when the environment is Unicode-capable', () => {
    expect(unicodeEnabled({ env: { LANG: 'en_US.UTF-8' } })).toBe(true)
    expect(unicodeEnabled({ env: { LANG: 'C' } })).toBe(false)
    expect(renderStatus('success', 'Ready', { env: { LANG: 'C' }, isTTY: true, color: 'never' })).toBe('[ok] Ready')
    expect(renderStatus('success', 'Ready', { env: { LANG: 'C' }, isTTY: true, color: 'never', unicode: true })).toBe('✓ Ready')
  })
})
