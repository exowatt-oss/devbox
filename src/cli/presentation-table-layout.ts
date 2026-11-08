import type { Alignment, TableColumn } from './presentation-types'
import { truncateText, visibleWidth } from './presentation-width'

export type PreparedTableColumn<Row> = {
  readonly source: TableColumn<Row>
  readonly index: number
  readonly values: readonly string[]
  readonly desiredWidth: number
  readonly minimumWidth: number
  width: number
}

export function retainColumns<Row>(
  columns: PreparedTableColumn<Row>[],
  width: number,
  requestedGap: number
): PreparedTableColumn<Row>[] {
  const active = [...columns]
  while (active.length > 1 && minimumTableWidth(active, width, requestedGap) > width) {
    const optional = active
      .filter((column) => column.source.optional === true)
      .sort((left, right) => (
        (left.source.priority ?? 0) - (right.source.priority ?? 0)
        || right.index - left.index
      ))
    const candidate = optional[0]
    if (candidate === undefined) {
      break
    }
    active.splice(active.indexOf(candidate), 1)
  }
  return active
}

export function fittingGap(
  width: number,
  columnCount: number,
  requestedGap: number
): number {
  if (columnCount <= 1) {
    return 0
  }
  const maximum = Math.floor((Math.max(0, width) - columnCount) / (columnCount - 1))
  return Math.max(0, Math.min(Math.max(0, Math.floor(requestedGap)), maximum))
}

export function allocateWidths<Row>(
  columns: PreparedTableColumn<Row>[],
  width: number,
  gap: number
): void {
  const available = Math.max(0, width - gap * Math.max(0, columns.length - 1))
  const minimumTotal = columns.reduce((total, column) => total + column.minimumWidth, 0)
  if (minimumTotal > available) {
    for (const column of columns) {
      column.width = 1
    }
    return
  }

  let remaining = available - minimumTotal
  const ranked = [...columns].sort((left, right) => (
    (right.source.priority ?? 0) - (left.source.priority ?? 0)
    || left.index - right.index
  ))
  const lowestPriority = Math.min(
    ...ranked.map((column) => column.source.priority ?? 0)
  )

  while (remaining > 0) {
    let grew = false
    for (const column of ranked) {
      const capacity = column.desiredWidth - column.width
      if (capacity <= 0) {
        continue
      }
      const quota = Math.max(
        1,
        (column.source.priority ?? 0) - lowestPriority + 1
      )
      const amount = Math.min(capacity, quota, remaining)
      column.width += amount
      remaining -= amount
      grew = true
      if (remaining === 0) {
        break
      }
    }
    if (!grew) {
      break
    }
  }
}

/**
 * Tables use whitespace as the column gutter rather than box-drawing
 * characters. Keeping this in the layout module makes the data and header
 * rows share exactly the same cell boundaries.
 */
export function tableGapText(gap: number): string {
  return ' '.repeat(Math.max(0, Math.floor(gap)))
}

/** Underline each header cell while leaving the gutter quiet. */
export function tableSeparator(gap: number): string {
  return ' '.repeat(Math.max(0, Math.floor(gap)))
}

export function formatTableCell(
  value: string,
  width: number,
  alignment: Alignment,
  padRight: boolean,
  ellipsis = '…'
): string {
  const text = truncateText(value, width, ellipsis)
  const missing = Math.max(0, width - visibleWidth(text))

  switch (alignment) {
    case 'right':
      return ' '.repeat(missing) + text
    case 'center': {
      const left = Math.floor(missing / 2)
      return ' '.repeat(left) + text + (
        padRight ? ' '.repeat(missing - left) : ''
      )
    }
    case 'left':
      return text + (padRight ? ' '.repeat(missing) : '')
  }
}

function minimumTableWidth<Row>(
  columns: readonly PreparedTableColumn<Row>[],
  width: number,
  requestedGap: number
): number {
  const gap = fittingGap(width, columns.length, requestedGap)
  return columns.reduce((total, column) => total + column.minimumWidth, 0)
    + gap * Math.max(0, columns.length - 1)
}
