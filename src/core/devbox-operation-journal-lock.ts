import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'

export const DEVBOX_OPERATION_JOURNAL_LOCK_TIMEOUT_MS = 5_000
export const DEVBOX_OPERATION_JOURNAL_LOCK_POLL_MS = 20
export const DEVBOX_OPERATION_JOURNAL_LOCK_STALE_MS = 30_000
export type DevboxOperationJournalLockOptions = {
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
}
export type DevboxOperationJournalLockResult =
  | { status: 'acquired'; release: () => void }
  | { status: 'rejected'; error: DevboxError }

type NodeFsError = NodeJS.ErrnoException

export function devboxOperationJournalLockPath(journalPath: string): string {
  return `${journalPath}.lock`
}

export function acquireDevboxOperationJournalLock(
  journalPath: string,
  options: DevboxOperationJournalLockOptions = {}
): DevboxOperationJournalLockResult {
  const lockPath = devboxOperationJournalLockPath(journalPath),
    timeoutMs = options.timeoutMs ?? DEVBOX_OPERATION_JOURNAL_LOCK_TIMEOUT_MS,
    pollMs = options.pollMs ?? DEVBOX_OPERATION_JOURNAL_LOCK_POLL_MS,
    staleMs = options.staleMs ?? DEVBOX_OPERATION_JOURNAL_LOCK_STALE_MS,
    deadline = Date.now() + timeoutMs
  try {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  } catch {
    return lockedResult()
  }
  let staleRecoveryUsed = false
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
        fsyncSync(fd)
      } catch {
        closeSync(fd)
        removeLock(lockPath)
        return lockedResult()
      }
      closeSync(fd)
      let released = false
      return {
        status: 'acquired',
        release: () => {
          if (!released) {
            released = true
            removeLock(lockPath)
          }
        }
      }
    } catch (error) {
      if (!isFsError(error, 'EEXIST')) {
        return lockedResult()
      }
      if (!staleRecoveryUsed && isStaleLock(lockPath, staleMs)) {
        staleRecoveryUsed = true
        removeLock(lockPath)
        continue
      }
      if (Date.now() >= deadline) {
        return lockedResult()
      }
      sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }
}

function lockedResult(): { status: 'rejected'; error: DevboxError } {
  return {
    status: 'rejected',
    error: createDevboxError('journal_locked', {
      context: { field: 'operation-journal-lock' }
    })
  }
}

function isStaleLock(lockPath: string, staleMs: number): boolean {
  let stat
  try {
    stat = statSync(lockPath)
  } catch {
    return false
  }
  const fileAge = Date.now() - stat.mtimeMs
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!isLockOwner(parsed)) {
      return fileAge >= staleMs
    }
    if (Date.now() - parsed.createdAt >= staleMs) {
      return true
    }
    try {
      process.kill(parsed.pid, 0)
      return fileAge >= staleMs
    } catch (error) {
      return isFsError(error, 'ESRCH')
    }
  } catch {
    return fileAge >= staleMs
  }
}

function isLockOwner(value: unknown): value is { pid: number; createdAt: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'createdAt' in value &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0
  )
}

function removeLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    // A missing lock is already released; other unlink failures are retried by stale recovery.
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isFsError(error: unknown, code: string): error is NodeFsError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
