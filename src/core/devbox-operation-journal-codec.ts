import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { DevboxOperationEnvelope } from '../shared/devbox-types'

export const DEVBOX_OPERATION_JOURNAL_SCHEMA_VERSION = 1 as const
export type DevboxOperationJournalRecord = {
  schemaVersion: typeof DEVBOX_OPERATION_JOURNAL_SCHEMA_VERSION
  recordId: string
  sequence: number
  operation: DevboxOperationEnvelope
  checksum: string
}
export type DevboxOperationJournalCheckpoint = {
  lastSequence: number
  operations: readonly DevboxOperationEnvelope[]
  checksum: string
}
export type RecordValue = Record<string, unknown>
export type JournalScan = {
  records: DevboxOperationJournalRecord[]
  truncated: boolean
  corrupt: boolean
}

const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export const json = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(json).join(',')}]`
    : record(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${json(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value)
export const digest = (value: unknown): string => createHash('sha256').update(json(value)).digest('hex')
export const readJournal = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')
export const isText = text

export function validRecord(value: unknown): value is DevboxOperationJournalRecord {
  if (
    !record(value) ||
    value.schemaVersion !== DEVBOX_OPERATION_JOURNAL_SCHEMA_VERSION ||
    !timestamp(value.sequence) ||
    !record(value.operation) ||
    !text(value.operation.operationId) ||
    !text(value.checksum)
  ) {
    return false
  }
  const typed = value as DevboxOperationJournalRecord
  const { checksum: _checksum, ...unsigned } = typed
  void _checksum
  return typed.checksum === digest(unsigned)
}

export function validCheckpoint(value: unknown): value is DevboxOperationJournalCheckpoint {
  if (
    !record(value) ||
    !timestamp(value.lastSequence) ||
    !Array.isArray(value.operations) ||
    !text(value.checksum)
  ) {
    return false
  }
  const typed = value as DevboxOperationJournalCheckpoint
  const { checksum: _checksum, ...unsigned } = typed
  void _checksum
  return typed.checksum === digest(unsigned)
}

export function scan(raw: string): JournalScan {
  if (!raw) {
    return { records: [], truncated: false, corrupt: false }
  }
  const lines = raw.split('\n'),
    terminated = raw.endsWith('\n'),
    records: DevboxOperationJournalRecord[] = []
  let truncated = false,
    corrupt = false
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return
    }
    const tail = index === lines.length - 1 && !terminated
    try {
      const parsed: unknown = JSON.parse(line)
      if (validRecord(parsed)) {
        records.push(parsed)
      } else if (tail) {
        truncated = true
      } else {
        corrupt = true
      }
    } catch {
      if (tail) {
        truncated = true
      } else {
        corrupt = true
      }
    }
  })
  return { records, truncated, corrupt }
}
