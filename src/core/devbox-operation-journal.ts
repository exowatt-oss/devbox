import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { acquireDevboxOperationJournalLock, type DevboxOperationJournalLockOptions } from './devbox-operation-journal-lock'
import {
  DEVBOX_OPERATION_JOURNAL_SCHEMA_VERSION,
  digest,
  isText,
  json,
  readJournal,
  scan,
  validCheckpoint,
  type DevboxOperationJournalCheckpoint,
  type DevboxOperationJournalRecord
} from './devbox-operation-journal-codec'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxOperationEnvelope } from '../shared/devbox-types'

export { DEVBOX_OPERATION_JOURNAL_SCHEMA_VERSION }
export type { DevboxOperationJournalCheckpoint, DevboxOperationJournalRecord }
export type DevboxJournalReplay = {
  status: 'ok' | 'truncated-tail' | 'corrupt' | 'locked'
  checkpointStatus: 'missing' | 'valid' | 'invalid'
  operations: readonly DevboxOperationEnvelope[]
  recordsRead: number
  recordsApplied: number
  duplicateRecords: number
  lastSequence: number
  error?: DevboxError
}

type JournalOptions = {
  journalPath: string
  checkpointPath?: string
  lockOptions?: DevboxOperationJournalLockOptions
}

export class DevboxOperationJournal {
  private readonly journalPath: string
  private readonly checkpointPath: string
  private readonly lockOptions: DevboxOperationJournalLockOptions | undefined

  constructor(options: JournalOptions) {
    this.journalPath = options.journalPath
    this.checkpointPath = options.checkpointPath ?? `${options.journalPath}.checkpoint`
    this.lockOptions = options.lockOptions
  }

  replay(): DevboxJournalReplay {
    const lock = acquireDevboxOperationJournalLock(this.journalPath, this.lockOptions)
    if (lock.status !== 'acquired') {
      return lockedReplay(lock.error)
    }
    try {
      return this.replayUnlocked()
    } finally {
      lock.release()
    }
  }

  append(operation: DevboxOperationEnvelope, options: { recordId: string }) {
    if (!isText(operation.operationId) || !isText(options.recordId)) {
      return { status: 'rejected', error: createDevboxError('journal_corrupt') } as const
    }
    const lock = acquireDevboxOperationJournalLock(this.journalPath, this.lockOptions)
    if (lock.status !== 'acquired') {
      return { status: 'rejected', error: lock.error } as const
    }
    try {
      const current = this.replayUnlocked()
      if (current.status !== 'ok') {
        return {
          status: 'rejected',
          error:
            current.error ??
            createDevboxError(
              current.status === 'truncated-tail' ? 'journal_truncated' : 'journal_corrupt'
            )
        } as const
      }
      const unsigned: Omit<DevboxOperationJournalRecord, 'checksum'> = {
        schemaVersion: DEVBOX_OPERATION_JOURNAL_SCHEMA_VERSION,
        recordId: options.recordId,
        sequence: current.lastSequence + 1,
        operation
      }
      const entry = { ...unsigned, checksum: digest(unsigned) }
      mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
      const fd = openSync(this.journalPath, 'a', 0o600)
      try {
        writeSync(fd, Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return { status: 'written', record: entry } as const
    } catch {
      return { status: 'rejected', error: createDevboxError('journal_corrupt') } as const
    } finally {
      lock.release()
    }
  }

  checkpoint() {
    const lock = acquireDevboxOperationJournalLock(this.journalPath, this.lockOptions)
    if (lock.status !== 'acquired') {
      return { status: 'rejected', error: lock.error } as const
    }
    try {
      const replay = this.replayUnlocked()
      if (replay.status !== 'ok') {
        return {
          status: 'rejected',
          error:
            replay.error ??
            createDevboxError(
              replay.status === 'truncated-tail' ? 'journal_truncated' : 'journal_corrupt'
            )
        } as const
      }
      const unsigned: Omit<DevboxOperationJournalCheckpoint, 'checksum'> = {
        lastSequence: replay.lastSequence,
        operations: replay.operations
      }
      const checkpoint = { ...unsigned, checksum: digest(unsigned) },
        tmp = `${this.checkpointPath}.${process.pid}.${Date.now()}.tmp`
      mkdirSync(dirname(this.checkpointPath), { recursive: true, mode: 0o700 })
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeSync(fd, Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8'))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.checkpointPath)
      return { status: 'checkpointed', checkpoint } as const
    } catch {
      return { status: 'rejected', error: createDevboxError('journal_checkpoint_invalid') } as const
    } finally {
      lock.release()
    }
  }

  private replayUnlocked(): DevboxJournalReplay {
    let checkpoint: DevboxOperationJournalCheckpoint | null = null
    let checkpointStatus: DevboxJournalReplay['checkpointStatus'] = 'missing'
    const checkpointText = readJournal(this.checkpointPath)
    if (existsSync(this.checkpointPath)) {
      try {
        const parsed: unknown = JSON.parse(checkpointText)
        checkpoint = validCheckpoint(parsed) ? parsed : null
        checkpointStatus = checkpoint ? 'valid' : 'invalid'
      } catch {
        checkpointStatus = 'invalid'
      }
    }
    const result = scan(readJournal(this.journalPath)),
      byId = new Map<string, DevboxOperationEnvelope>()
    for (const operation of checkpoint?.operations ?? []) {
      byId.set(operation.operationId, operation)
    }
    const seen = new Set<string>(),
      sameSequence = new Map<string, string>()
    let applied = 0,
      duplicates = 0,
      lastSequence = checkpoint?.lastSequence ?? 0
    const records = [...result.records].sort(
      (a, b) => a.sequence - b.sequence || a.recordId.localeCompare(b.recordId)
    )
    for (const entry of records) {
      lastSequence = Math.max(lastSequence, entry.sequence)
      if (entry.sequence <= (checkpoint?.lastSequence ?? 0)) {
        duplicates++
        continue
      }
      const operationJson = json(entry.operation),
        sequenceKey = `${entry.sequence}:${entry.operation.operationId}`
      const prior = sameSequence.get(sequenceKey)
      if (prior !== undefined && prior !== operationJson) {
        return {
          status: 'corrupt',
          checkpointStatus,
          operations: [],
          recordsRead: records.length,
          recordsApplied: applied,
          duplicateRecords: duplicates,
          lastSequence,
          error: createDevboxError('journal_corrupt')
        }
      }
      sameSequence.set(sequenceKey, operationJson)
      const eventKey = `${sequenceKey}:${operationJson}`
      if (seen.has(eventKey)) {
        duplicates++
        continue
      }
      seen.add(eventKey)
      byId.set(entry.operation.operationId, entry.operation)
      applied++
    }
    const status: DevboxJournalReplay['status'] = result.corrupt
      ? 'corrupt'
      : result.truncated
        ? 'truncated-tail'
        : 'ok'
    return {
      status,
      checkpointStatus,
      operations: [...byId.values()].sort((a, b) => a.operationId.localeCompare(b.operationId)),
      recordsRead: records.length,
      recordsApplied: applied,
      duplicateRecords: duplicates,
      lastSequence,
      ...(status === 'corrupt'
        ? { error: createDevboxError('journal_corrupt') }
        : status === 'truncated-tail'
          ? { error: createDevboxError('journal_truncated') }
          : {})
    }
  }
}

function lockedReplay(error: DevboxError): DevboxJournalReplay {
  return {
    status: 'locked',
    checkpointStatus: 'missing',
    operations: [],
    recordsRead: 0,
    recordsApplied: 0,
    duplicateRecords: 0,
    lastSequence: 0,
    error
  }
}
