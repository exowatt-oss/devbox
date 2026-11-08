import {
  colorEnabled,
  getTerminalWidth,
  styleText,
  unicodeEnabled
} from './presentation-ansi'
import type {
  KeyValueEntry,
  KeyValueOptions,
  LocalTableOptions,
  Presentation,
  PresentationOptions,
  StatusKind,
  StatusOptions,
  TableRenderOptions,
  WrapTextOptions
} from './presentation-types'
import { renderTable } from './presentation-table'
import { wrapText } from './presentation-wrap'
import { padText, truncateText, visibleWidth } from './presentation-width'

/** Render left-aligned labels with a stable colon/value column. */
export function renderKeyValue(
  entries: Readonly<Record<string, unknown>> | readonly KeyValueEntry[],
  options: KeyValueOptions = {}
): string {
  const pairs = Array.isArray(entries)
    ? entries.map((entry) => ({
      label: entry.label ?? entry.key ?? '',
      value: entry.value
    }))
    : Object.entries(entries).map(([label, value]) => ({ label, value }))
  if (pairs.length === 0) {
    return ''
  }

  const labels = pairs.map((pair) => pair.label)
  const labelWidth = options.labelWidth
    ?? Math.max(...labels.map((label) => visibleWidth(label)), 0)
  const separator = options.separator ?? ': '

  return pairs.map((pair) => {
    const label = options.labelStyle === false
      ? pair.label
      : styleText(pair.label, options.labelStyle ?? 'label', options)
    const value = displayValue(pair.value) || options.emptyValue || '-'
    const prefix = `${padText(label, labelWidth, 'left')}${separator}`
    const valueWidth = Math.max(1, getTerminalWidth(options) - visibleWidth(prefix))
    return wrapText(value, valueWidth, { preserveIndent: false })
      .map((line, index) => {
        const styledValue = options.valueStyle === false
          ? line
          : options.valueStyle === undefined
            ? line
            : styleText(line, options.valueStyle, options)
        const continuation = index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))
        return `${continuation}${styledValue}`.replace(/\s+$/u, '')
      })
      .join('\n')
  }).join('\n')
}

/** Render a compact semantic status line with an ASCII fallback symbol. */
export function renderStatus(
  kind: StatusKind,
  message?: unknown,
  options: StatusOptions = {}
): string {
  const unicode = options.unicode ?? unicodeEnabled(options)
  const requestedSymbol = options.symbol === false ? '' : statusSymbol(kind, unicode)
  const width = getTerminalWidth(options)
  const symbol = requestedSymbol.length === 0
    ? ''
    : truncateText(requestedSymbol, Math.max(0, width - 1), '')
  const prefixWidth = symbol.length === 0 ? 0 : visibleWidth(symbol) + 1
  const content = singleLine(message === undefined ? kind : displayValue(message))
  if (content.length === 0) {
    return styleText(symbol, kind, options)
  }
  const contentWidth = Math.max(1, width - prefixWidth)
  const wrapped = wrapText(content, contentWidth, { preserveIndent: false })
  const lines = wrapped.map((line, index) => (
    index === 0
      ? statusLine(symbol, line)
      : `${' '.repeat(prefixWidth)}${line}`
  ))
  return styleText(lines.join('\n'), kind, options)
}

/** Render a quiet, non-error result when a collection has no rows. */
export function renderEmptyState(
  message = 'No items found.',
  options: PresentationOptions = {}
): string {
  const unicode = options.unicode ?? unicodeEnabled(options)
  const prefix = unicode ? '·' : '-'
  const content = singleLine(message)
  return styleText(
    content.length === 0 ? prefix : `${prefix} ${content}`,
    'muted',
    options
  )
}

export function renderTitle(
  title: string,
  options: PresentationOptions = {}
): string {
  return styleText(singleLine(title), 'title', options)
}

export function renderSection(
  title: string,
  options: PresentationOptions = {}
): string {
  return styleText(singleLine(title), 'section', options)
}

export const title = renderTitle
export const section = renderSection
export const keyValue = renderKeyValue
export const status = renderStatus
export const emptyState = renderEmptyState

/** Bind terminal decisions once for a command that emits several sections. */
export function createPresentation(options: PresentationOptions = {}): Presentation {
  const color = colorEnabled(options)
  const width = getTerminalWidth(options)
  const bind = <T extends object>(local: T): T & PresentationOptions => ({
    ...options,
    ...local,
    color
  })

  return {
    color,
    width,
    style: (text, semanticStyle) => styleText(text, semanticStyle, { ...options, color }),
    wrap: (text, localWidth = width, wrapOptions: WrapTextOptions = {}) => (
      wrapText(text, localWidth, wrapOptions)
    ),
    title: (text) => renderTitle(text, { ...options, color }),
    section: (text) => renderSection(text, { ...options, color }),
    keyValue: (entries, localOptions = {}) => renderKeyValue(entries, bind(localOptions)),
    status: (kind, message, localOptions = {}) => (
      renderStatus(kind, message, bind(localOptions))
    ),
    emptyState: (message = 'No items found.') => renderEmptyState(
      message,
      { ...options, color }
    ),
    table: <Row>(tableOptions: LocalTableOptions<Row>) => {
      const { columns, ...rest } = tableOptions
      const tableOptionsWithDefaults: TableRenderOptions<Row> = {
        ...options,
        ...rest,
        color,
        width: tableOptions.width ?? width,
        columns
      }
      return renderTable(tableOptionsWithDefaults)
    }
  }
}

function statusLine(symbol: string, content: string): string {
  if (content.length === 0) {
    return symbol
  }
  if (symbol.length > 0) {
    return `${symbol} ${content}`
  }
  return content
}

function statusSymbol(kind: StatusKind, unicode: boolean): string {
  if (unicode) {
    switch (kind) {
      case 'success':
        return '✓'
      case 'warning':
        return '!'
      case 'error':
        return '×'
      case 'info':
        return 'i'
      case 'muted':
        return '·'
    }
  }

  switch (kind) {
    case 'success':
      return '[ok]'
    case 'warning':
      return '[warn]'
    case 'error':
      return '[error]'
    case 'info':
      return '[info]'
    case 'muted':
      return '[-]'
  }
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'string' ? value : String(value)
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ')
}
