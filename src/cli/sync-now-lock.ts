import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Exclusive run lock for `db sync` at `<state root>/sync.lock` (JSON `{ pid, startedAt, command }`).
 * `db mutagen stop|restart` take the same lock so a daemon restart never lands mid-sync.
 * The record is written to a temp file and hard-linked into place, so a reader never
 * sees a half-written lock; a lock whose pid is gone is stale and is replaced.
 */
/** `command` names the holder for whoever waits: `db sync`, `db mutagen restart`, ... */
export type SyncLockHolder = { pid: number; startedAt?: number; command?: string }

export type SyncLockHandle = { release(): void }

export type SyncLockOptions = {
  path: string
  pid?: number
  /** Recorded so a waiter can say what it waits for (default `db sync`). */
  command?: string
  now?: () => number
  isAlive?: (pid: number) => boolean
  /** When a live pid's process started (epoch ms), to spot a pid reused after a crash or reboot. */
  startedAtOf?: (pid: number) => number | undefined
  /** Poll interval while another live process holds the lock (default 1 s). */
  pollMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Called when waiting starts and whenever the holder changes. */
  onWait?: (holder: SyncLockHolder) => void
  signal?: AbortSignal
}

export function syncLockPath(stateRoot: string): string {
  return join(stateRoot, 'sync.lock')
}

/** Waits until the lock is free and takes it; undefined when the signal aborted the wait. */
export async function acquireSyncLock(options: SyncLockOptions): Promise<SyncLockHandle | undefined> {
  const sleep = options.sleep ?? abortableSleep
  let announced: string | undefined
  for (;;) {
    if (options.signal?.aborted) {return undefined}
    const attempt = tryAcquireSyncLock(options)
    if ('handle' in attempt) {return attempt.handle}
    const identity = `${attempt.holder.pid}:${attempt.holder.startedAt ?? ''}`
    if (identity !== announced) {
      announced = identity
      options.onWait?.(attempt.holder)
    }
    await sleep(options.pollMs ?? 1_000, options.signal)
  }
}

export function tryAcquireSyncLock(options: SyncLockOptions): { handle: SyncLockHandle } | { holder: SyncLockHolder } {
  const pid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? processAlive
  const record = JSON.stringify({ pid, startedAt: (options.now ?? Date.now)(), command: options.command ?? 'db sync' })
  mkdirSync(dirname(options.path), { recursive: true })
  const temp = `${options.path}.${pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${record}\n`, { mode: 0o600 })
  try {
    let holder: SyncLockHolder = { pid: 0 }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        linkSync(temp, options.path)
        return { handle: { release: () => releaseIfOwned(options.path, record) } }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
      }
      const raw = readText(options.path)
      if (raw === undefined) {continue}
      const parsed = parseHolder(raw)
      if (parsed !== undefined && isAlive(parsed.pid) && !reusedPid(parsed, options.startedAtOf ?? processStartedAt)) {return { holder: parsed }}
      holder = parsed ?? holder
      if (readText(options.path) === raw) {removeQuietly(options.path)}
    }
    return { holder }
  } finally {
    removeQuietly(temp)
  }
}

function releaseIfOwned(path: string, record: string): void {
  if (readText(path)?.trim() === record) {removeQuietly(path)}
}

function parseHolder(raw: string): SyncLockHolder | undefined {
  try {
    const value = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; command?: unknown }
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) {return undefined}
    return {
      pid: value.pid,
      ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
      ...(typeof value.command === 'string' && value.command.length > 0 ? { command: value.command.slice(0, 40) } : {})
    }
  } catch {
    return undefined
  }
}

/**
 * A live pid whose process started after the lock was written is not the holder: the
 * holder died without releasing (crash, reboot) and the pid was handed out again.
 * Without this a stale lock could make every later run wait forever.
 */
function reusedPid(holder: SyncLockHolder, startedAtOf: (pid: number) => number | undefined): boolean {
  if (holder.startedAt === undefined) {return false}
  const started = startedAtOf(holder.pid)
  return started !== undefined && started > holder.startedAt + 5_000
}

/** `ps -o etime=` (`[[dd-]hh:]mm:ss`) → start time; undefined when ps is unavailable. */
export function processStartedAt(pid: number, now: number = Date.now()): number | undefined {
  try {
    const etime = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(etime)
    if (match === null) {return undefined}
    const [days, hours, minutes, secs] = match.slice(1).map((part) => Number(part ?? 0))
    return now - ((((days! * 24 + hours!) * 60 + minutes!) * 60 + secs!) * 1_000)
  } catch {
    return undefined
  }
}

/** The live process holding the run lock, if any; never takes or changes the lock. */
export function readSyncLockHolder(path: string, isAlive: (pid: number) => boolean = processAlive): SyncLockHolder | undefined {
  const raw = readText(path)
  const holder = raw === undefined ? undefined : parseHolder(raw)
  return holder !== undefined && isAlive(holder.pid) ? holder : undefined
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}
