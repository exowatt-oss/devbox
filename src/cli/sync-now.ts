import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { SshEndpoint } from '../shared/ssh-runner-types'
import type { SyncHooks } from './sync-now-hooks'
import type { SyncLockHandle, SyncLockHolder } from './sync-now-lock'
import { abortableSleep } from './sync-now-lock'
import { oneLine, runSyncMachine, SYNC_BUSY_NOTE_MS, type SyncPauses, type SyncPoller } from './sync-now-machine'
import { SyncMutagenError, type SyncNowMutagen } from './sync-now-mutagen'
import { planSyncNow, type SyncNowSelection } from './sync-now-plan'
import type { SyncReach } from './sync-now-reach'
import type { SyncSessionSnapshot } from './sync-now-session'
import type { SyncMachineOutcome, SyncNowEvent, SyncNowListener, SyncNowResult } from './sync-now-types'

/**
 * `db sync` engine: take the run lock, plan every Devbox-owned Mutagen session by
 * machine, sync all machines concurrently (each skipping itself when unreachable,
 * stalled, or over its cap), and always end with every session of the run paused.
 */
export type SyncNowOptions = {
  selection: SyncNowSelection
  wake: boolean
  /** Per-machine hard cap; 0 = none. */
  timeoutMs: number
  /** How long an endpoint may stay disconnected/connecting mid-sync (default 30 s). */
  stallGraceMs?: number
  /** `sync list` cadence (default 500 ms). */
  pollIntervalMs?: number
  /** Failing status polls in a row this long show the `Mutagen busy` note (default 10 s). */
  busyNoteMs?: number
}

export type SyncNowDeps = {
  mutagen: SyncNowMutagen
  profiles: () => readonly DevboxProfileV1[]
  endpointFor: (profile: DevboxProfileV1) => SshEndpoint
  isLocal: (endpoint: SshEndpoint) => boolean
  home: string
  /** os.tmpdir(), for showing the paste root as `$TMPDIR`. */
  tmpDir?: string
  reach: SyncReach
  hooks: SyncHooks
  acquireLock: (onWait: (holder: SyncLockHolder) => void, signal: AbortSignal) => Promise<SyncLockHandle | undefined>
  /** Starts the Mutagen daemon through the keepalive service (as `mutagen start` does). */
  startDaemon: () => Promise<unknown>
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const SYNC_NOW_DEFAULT_TIMEOUT_SECONDS = 900
export const SYNC_NOW_STALL_GRACE_MS = 30_000

export async function runSyncNow(
  options: SyncNowOptions,
  deps: SyncNowDeps,
  listener: SyncNowListener,
  signal: AbortSignal = new AbortController().signal
): Promise<SyncNowResult> {
  const now = deps.now ?? Date.now
  const emit = (event: SyncNowEvent): void => {
    try { listener(event) } catch { /* rendering is cosmetic and never stops a sync */ }
  }
  const lock = await deps.acquireLock((holder) => emit({
    type: 'lock-wait',
    holderPid: holder.pid,
    ...(holder.startedAt === undefined ? {} : { holderStartedAt: holder.startedAt }),
    ...(holder.command === undefined ? {} : { holderCommand: holder.command })
  }), signal)
  if (lock === undefined) {return finish(emit, summarize(now(), now(), [], true))}
  const pauses = createPauseTracker(deps.mutagen)
  // A hard exit (second Ctrl-C) skips the awaited re-pause: hand it to the daemon on the way out.
  const onExit = (): void => pauses.abandon()
  process.on('exit', onExit)
  const poller = createSyncPoller(deps.mutagen, options.pollIntervalMs ?? 500, deps.sleep ?? abortableSleep, (error, forMs) => emit({ type: 'warning', message: `Mutagen daemon not answering status polls for ${Math.round(forMs / 1000)} s: ${oneLine(error)}` }), now)
  let result: SyncNowResult
  let restored = false
  try {
    const sessions = await listWithDaemon(deps)
    const targets = planSyncNow({ sessions, profiles: deps.profiles(), home: deps.home, ...(deps.tmpDir === undefined ? {} : { tmpDir: deps.tmpDir }), selection: options.selection, endpointFor: deps.endpointFor, isLocal: deps.isLocal })
    const startedAt = now()
    emit({ type: 'plan', plan: { machines: targets.map((target) => target.machine), startedAt, timeoutMs: options.timeoutMs } })
    const outcomes = await Promise.all(targets.map((target) => runSyncMachine({
      target,
      wake: options.wake,
      timeoutMs: options.timeoutMs,
      stallGraceMs: options.stallGraceMs ?? SYNC_NOW_STALL_GRACE_MS,
      busyNoteMs: options.busyNoteMs ?? SYNC_BUSY_NOTE_MS,
      mutagen: deps.mutagen,
      reach: deps.reach,
      hooks: deps.hooks,
      poller,
      pauses,
      emit,
      signal,
      now
    })))
    const leftover = await pauses.restoreAll()
    restored = true
    if (leftover !== undefined) {emit({ type: 'warning', message: leftover })}
    result = summarize(startedAt, now(), outcomes, signal.aborted)
  } finally {
    poller.stop()
    if (!restored) {await pauses.restoreAll()}
    process.off('exit', onExit)
    lock.release()
  }
  return finish(emit, result)
}

function finish(emit: (event: SyncNowEvent) => void, result: SyncNowResult): SyncNowResult {
  emit({ type: 'finished', result })
  return result
}

/** Lists sessions; when the daemon is down, starts it once through the service and retries. */
async function listWithDaemon(deps: SyncNowDeps): Promise<SyncSessionSnapshot[]> {
  try {
    return await deps.mutagen.list()
  } catch (first) {
    try {
      await deps.startDaemon()
      return await deps.mutagen.list()
    } catch (second) {
      throw new Error(`The Devbox Mutagen daemon is not answering and could not be started (${oneLine(second) || oneLine(first)}). Check \`devbox mutagen status\` and \`devbox mutagen logs\`.`, { cause: second })
    }
  }
}

function summarize(startedAt: number, endedAt: number, machines: readonly SyncMachineOutcome[], interrupted: boolean): SyncNowResult {
  const count = (state: SyncMachineOutcome['state']): number => machines.filter((machine) => machine.state === state).length
  const failedCount = count('failed')
  return {
    ok: failedCount === 0 && !interrupted,
    startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    machines: [...machines],
    syncedCount: count('synced'),
    skippedCount: count('skipped'),
    failedCount,
    interrupted
  }
}

export function createPauseTracker(mutagen: Pick<SyncNowMutagen, 'pause' | 'list' | 'pauseDetached'>): SyncPauses & {
  restoreAll(): Promise<string | undefined>
  /** Synchronous last resort for process exit: a detached `sync pause` for whatever is still resumed. */
  abandon(): void
} {
  const resumed = new Set<string>()
  const repause = async (ids: readonly string[]): Promise<string | undefined> => {
    const pending = ids.filter((id) => resumed.has(id))
    if (pending.length === 0) {return undefined}
    let failure: unknown
    try {
      await mutagen.pause(pending)
    } catch (error) {
      failure = error
    }
    if (failure === undefined) {
      for (const id of pending) {resumed.delete(id)}
      return undefined
    }
    // Only sessions the daemon confirms paused leave the tracker. One still running (a
    // timed-out pause, a hung daemon) stays tracked so the end of the run asks again, and
    // the next `db sync` pauses whatever it finds running: a lost pause never leaves a
    // session live-syncing.
    const running = await stillRunning(mutagen, pending)
    for (const id of pending) {if (!running.includes(id)) {resumed.delete(id)}}
    if (running.length === 0) {return undefined}
    return failure instanceof SyncMutagenError && failure.timedOut
      ? `${running.length} session(s) still pausing (Mutagen finishes the running scan first); the next \`db sync\` pauses them if they are still running`
      : `could not pause ${running.length} session(s) again (${oneLine(failure)}); the next \`db sync\` pauses them, or run \`devbox mutagen pause\` for the profile`
  }
  return {
    markResumed: (ids) => { for (const id of ids) {resumed.add(id)} },
    repause,
    restoreAll: () => repause([...resumed]),
    abandon: () => {
      if (resumed.size === 0) {return}
      try { mutagen.pauseDetached?.([...resumed]) } catch { /* exiting anyway */ }
      resumed.clear()
    }
  }
}

async function stillRunning(mutagen: Pick<SyncNowMutagen, 'list'>, ids: readonly string[]): Promise<string[]> {
  try {
    const sessions = await mutagen.list()
    return ids.filter((id) => sessions.find((session) => session.id === id)?.paused !== true)
  } catch {
    return [...ids]
  }
}

/** Poll failures in a row this long earn one warning (a busy daemon misses the odd poll). */
export const SYNC_POLL_WARN_MS = 10_000

/**
 * One `sync list` at a time, every `intervalMs`, only while some machine is watching a
 * flush. A failed poll reaches the listeners as `undefined` so they can tell a silent
 * daemon from a quiet one.
 */
export function createSyncPoller(
  mutagen: Pick<SyncNowMutagen, 'list'>,
  intervalMs: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  onPersistentError: (error: unknown, forMs: number) => void,
  now: () => number = Date.now
): SyncPoller & { stop(): void } {
  const listeners = new Set<(sessions: readonly SyncSessionSnapshot[] | undefined) => void>()
  const stopper = new AbortController()
  let running = false
  let reported = false
  let failingSince: number | undefined
  const loop = async (): Promise<void> => {
    while (listeners.size > 0 && !stopper.signal.aborted) {
      let sessions: SyncSessionSnapshot[] | undefined
      try {
        sessions = await mutagen.list()
        failingSince = undefined
      } catch (error) {
        failingSince ??= now()
        if (!reported && now() - failingSince >= SYNC_POLL_WARN_MS) {
          reported = true
          onPersistentError(error, now() - failingSince)
        }
      }
      for (const listener of listeners) {listener(sessions)}
      await sleep(intervalMs, stopper.signal)
    }
    running = false
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!running) {
        running = true
        void loop()
      }
      return () => { listeners.delete(listener) }
    },
    stop: () => stopper.abort()
  }
}
