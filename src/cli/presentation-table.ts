import { getTerminalWidth, styleText, unicodeEnabled } from './presentation-ansi'
import type {
  SemanticStyle,
  TableCallOptions,
  TableColumn,
  TablePresentationOptions,
  TableRenderOptions
} from './presentation-types'
import {
  allocateWidths,
  fittingGap,
  formatTableCell,
  retainColumns,
  tableGapText,
  tableSeparator,
  type PreparedTableColumn
} from './presentation-table-layout'
import { visibleWidth } from './presentation-width'

const DEFAULT_TABLE_GAP = 3

/**
 * Render a compact table. Optional columns disappear before required columns
 * are made unreadably narrow; priorities make that decision stable.
 */
export function renderTable<Row>(options: TableRenderOptions<Row>): string
export function renderTable<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  options?: TableCallOptions
): string
export function renderTable<Row>(
  input: TableRenderOptions<Row> | readonly Row[],
  columnsOrOptions?: readonly TableColumn<Row>[] | TableCallOptions,
  alternateOptions: TableCallOptions = {}
): string {
  const tableOptions = isRows(input)
    ? tableFromArguments(input, columnsOrOptions, alternateOptions)
    : input

  if (tableOptions.columns.length === 0) {
    return ''
  }

  const prepared = tableOptions.columns.map((column, index) => {
    const values = tableOptions.rows.map((row, rowIndex) => (
      cellText(column, row, rowIndex)
    ))
    const desiredWidth = Math.max(
      1,
      visibleWidth(column.header),
      ...values.map((value) => visibleWidth(value))
    )
    // Keep columns intact while optional columns are considered so that
    // low-value fields disappear before core fields are mangled.
    const minimumWidth = Math.max(
      1,
      Math.min(desiredWidth, column.minWidth ?? desiredWidth)
    )
    return {
      source: column,
      index,
      values,
      desiredWidth,
      minimumWidth,
      width: minimumWidth
    } satisfies PreparedTableColumn<Row>
  })

  const width = getTerminalWidth({
    width: tableOptions.width,
    output: tableOptions.output,
    env: tableOptions.env
  })
  const requestedGap = tableOptions.gap ?? DEFAULT_TABLE_GAP
  const active = retainColumns(prepared, width, requestedGap)
  if (active.length === 0) {
    return ''
  }

  const gap = fittingGap(width, active.length, requestedGap)
  allocateWidths(active, width, gap)
  const gapText = tableGapText(gap)
  const lines: string[] = []

  if (tableOptions.header !== false) {
    lines.push(renderTableLine(
      active,
      active.map((column) => column.source.header),
      gapText,
      tableOptions,
      tableOptions.headerStyle === false
        ? undefined
        : tableOptions.headerStyle ?? 'section'
    ))
    if (tableOptions.separator !== false) {
      const underline = active.map((column) => '-'.repeat(column.width)).join(tableSeparator(gap))
      lines.push(styleText(underline, 'muted', {
        color: tableOptions.color,
        env: tableOptions.env,
        isTTY: tableOptions.isTTY,
        output: tableOptions.output,
        unicode: tableOptions.unicode
      }))
    }
  }

  for (let rowIndex = 0; rowIndex < tableOptions.rows.length; rowIndex += 1) {
    lines.push(renderTableLine(
      active,
      active.map((column) => column.values[rowIndex] ?? ''),
      gapText,
      tableOptions
    ))
  }
  return lines.join('\n')
}

function isRows<Row>(
  input: TableRenderOptions<Row> | readonly Row[]
): input is readonly Row[] {
  return Array.isArray(input)
}

function isColumnList<Row>(
  value: readonly TableColumn<Row>[] | TableCallOptions | undefined
): value is readonly TableColumn<Row>[] {
  return Array.isArray(value)
}

function tableFromArguments<Row>(
  rows: readonly Row[],
  columnsOrOptions: readonly TableColumn<Row>[] | TableCallOptions | undefined,
  alternateOptions: TableCallOptions
): TableRenderOptions<Row> {
  const columns = isColumnList(columnsOrOptions) ? columnsOrOptions : []
  const options = isColumnList(columnsOrOptions)
    ? alternateOptions
    : columnsOrOptions ?? alternateOptions
  return { ...options, rows, columns }
}

function cellText<Row>(
  column: TableColumn<Row>,
  row: Row,
  rowIndex: number
): string {
  let value: unknown
  if (column.get !== undefined) {
    value = column.get(row, rowIndex)
  } else if (column.accessor !== undefined) {
    value = column.accessor(row, rowIndex)
  } else if (column.key !== undefined && isRecord(row)) {
    value = row[column.key]
  }

  const formatted = column.format === undefined
    ? displayValue(value)
    : column.format(value, row, rowIndex)
  // A table is one line per row. Do not let a value create unaligned output.
  return formatted.replace(/[\r\n]+/gu, ' ').replace(/\t/gu, ' ')
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'string' ? value : String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function renderTableLine<Row>(
  columns: readonly PreparedTableColumn<Row>[],
  values: readonly string[],
  gap: string,
  options: TablePresentationOptions,
  style?: SemanticStyle
): string {
  const ellipsis = unicodeEnabled(options) ? '…' : '...'
  return columns.map((column, index) => {
    const value = style === undefined
      ? values[index] ?? ''
      : styleText(values[index] ?? '', style, options)
    const finalColumn = index === columns.length - 1
    return formatTableCell(
      value,
      column.width,
      column.source.align ?? 'left',
      !finalColumn,
      ellipsis
    )
  }).join(gap).replace(/\s+$/u, '')
}
