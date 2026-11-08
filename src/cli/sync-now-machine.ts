import type { SyncHookPhase, SyncHooks } from './sync-now-hooks'
import { isConnectionError, SyncMutagenError, type SyncFlushHandle, type SyncNowMutagen } from './sync-now-mutagen'
import type { SyncNowTarget } from './sync-now-plan'
import type { SyncReach } from './sync-now-reach'
import { formatDuration } from './sync-now-render-format'
import { isDisconnected, isHaltedStatus, laneProgressOf, machinePhaseOf, type SyncSessionSnapshot } from './sync-now-session'
import type { SyncLaneProgress, SyncMachineOutcome, SyncNowListener, SyncPhase, SyncSkipReason } from './sync-now-types'

/** Shared `sync list` poller: one child at a time for every machine in the run; `undefined` = that poll failed. */
export type SyncPoller = {
  subscribe(listener: (sessions: readonly SyncSessionSnapshot[] | undefined) => void): () => void
}

/** Remembers which sessions this run must pause: every one it resumed or found running. */
export type SyncPauses = {
  markResumed(ids: readonly string[]): void
  /** Pauses the given ids that are tracked as running; resolves a warning on failure. */
  repause(ids: readonly string[]): Promise<string | undefined>
}

export type SyncMachineRun = {
  target: SyncNowTarget
  wake: boolean
  /** 0 = no cap. */
  timeoutMs: number
  stallGraceMs: number
  /** Failing status polls in a row this long show the muted `Mutagen busy` note. */
  busyNoteMs: number
  mutagen: SyncNowMutagen
  reach: SyncReach
  hooks: SyncHooks
  poller: SyncPoller
  pauses: SyncPauses
  emit: SyncNowListener
  signal: AbortSignal
  now: () => number
}

type FlushOutcome =
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  | { kind: 'stalled'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'interrupted' }

/** One machine end to end: probe, `before` hooks, resume, flush under watch, re-pause, `after` hooks. Never rejects. */
export async function runSyncMachine(run: SyncMachineRun): Promise<SyncMachineOutcome> {
  const { target, emit, now } = run
  const machine = target.machine
  const started = now()
  const deadline = run.timeoutMs > 0 ? started + run.timeoutMs : Number.POSITIVE_INFINITY
  const sessionIds = machine.lanes.flatMap((lane) => lane.sessionIds)
  const pausedIds = machine.lanes.flatMap((lane) => lane.pausedBefore)
  // Devbox never leaves a session running: one found running (a pause an earlier run lost,
  // a stray `mutagen sync resume`) is paused at the end like the ones this run resumes.
  run.pauses.markResumed(sessionIds.filter((id) => !pausedIds.includes(id)))
  const progress = new Map<string, SyncLaneProgress>()
  /** Sessions whose own flush completed: their lanes are synced whatever the rest of the machine does. */
  const flushed = new Set<string>()
  const warnings: string[] = []
  let current: SyncPhase | undefined
  let currentDetail: string | undefined
  const phase = (next: SyncPhase, detail?: string): void => {
    if (next === current && detail === currentDetail) {return}
    current = next
    currentDetail = detail
    emit({ type: 'machine-phase', machineKey: machine.key, phase: next, ...(detail === undefined ? {} : { detail }) })
  }
  const warn = (message: string | undefined): void => {
    if (message === undefined || warnings.includes(message)) {return}
    warnings.push(message)
    emit({ type: 'warning', machineKey: machine.key, message })
  }
  const done = async (state: SyncMachineOutcome['state'], reason?: SyncSkipReason, detail?: string): Promise<SyncMachineOutcome> => {
    warn(await run.pauses.repause(sessionIds))
    const outcome = outcomeOf(target, state, reason, detail, now() - started, warnings, progress, flushed)
    emit({ type: 'machine-done', outcome })
    return outcome
  }
  const timeoutDetail = `still syncing at the ${seconds(run.timeoutMs)} --timeout cap`
  const hooks = async (hookPhase: SyncHookPhase, profileIds: readonly string[] = target.profileIds): Promise<void> => {
    const found = profileIds.flatMap((profileId) => {
      const path = run.hooks.find(profileId)
      return path === undefined ? [] : [{ profileId, path }]
    })
    if (found.length === 0) {return}
    phase(hookPhase === 'before' ? 'preparing' : 'finishing')
    for (const hook of found) {
      warn(await run.hooks.run(hook.path, hookPhase, { profileId: hook.profileId, host: machine.host, user: machine.user }, run.signal))
    }
  }

  try {
    if (run.signal.aborted) {return await done('skipped', 'interrupted', 'interrupted')}
    phase('checking')
    const reach = await run.reach(target, { wake: run.wake, signal: run.signal, onWaking: (detail) => phase('waking', detail) })
    if (run.signal.aborted) {return await done('skipped', 'interrupted', 'interrupted')}
    if (!reach.ok) {return await done('skipped', reach.reason, reach.detail)}
    if (now() >= deadline) {return await done('skipped', 'timeout', timeoutDetail)}
    await hooks('before')
    if (run.signal.aborted) {return await done('skipped', 'interrupted', 'interrupted')}
    phase('connecting')
    run.pauses.markResumed(pausedIds)
    /** Set when resume could not connect: the session stays unpaused and Mutagen keeps retrying. */
    let connectError: string | undefined
    try {
      await run.mutagen.resume(pausedIds)
    } catch (error) {
      // A timed-out resume, or one that could not connect yet, keeps connecting inside the
      // daemon; the stall rule decides. Only a real session error fails the machine.
      if (run.signal.aborted) {return await done('skipped', 'interrupted', 'interrupted')}
      if (!(error instanceof SyncMutagenError && error.timedOut)) {
        const message = oneLine(error)
        if (!isConnectionError(error)) {return await done('failed', undefined, message)}
        connectError = message
      }
    }
    const result = await watchFlush(run, sessionIds, deadline, progress, flushed, phase, (detail) => { if (current !== undefined) {phase(current, detail)} })
    // Ctrl-C reaches the flush child too; its exit must not read as a Mutagen failure.
    if (result.kind === 'interrupted' || (result.kind !== 'ok' && run.signal.aborted)) {return await done('skipped', 'interrupted', 'interrupted')}
    if (result.kind !== 'ok') {
      // Lanes that finished their own flush count as synced; their profiles still get `after`.
      warn(await run.pauses.repause(sessionIds))
      const synced = target.profileIds.filter((profileId) => {
        const lanes = machine.lanes.filter((lane) => lane.profileId === profileId)
        return lanes.length > 0 && lanes.every((lane) => laneFlushed(lane.sessionIds, flushed))
      })
      if (synced.length > 0 && !run.signal.aborted) {await hooks('after', synced)}
      if (run.signal.aborted) {return await done('skipped', 'interrupted', 'interrupted')}
      if (result.kind === 'error') {return await done('failed', undefined, result.message)}
      if (result.kind === 'stalled') {return await (connectError === undefined ? done('skipped', 'stalled', result.detail) : done('skipped', 'unreachable', connectError))}
      return await done('skipped', 'timeout', timeoutDetail)
    }
    phase('finishing')
    await refreshProgress(run, progress)
    warn(await run.pauses.repause(sessionIds))
    await hooks('after')
    return await done('synced')
  } catch (error) {
    return await done('failed', undefined, oneLine(error) || 'unexpected error')
  }
}

/**
 * Waits until every session of the machine is connected (Mutagen rejects a flush while an
 * endpoint is reconnecting), then flushes all of them at once and watches the flush. The
 * stall rule covers both the wait and the flush; the cap and Ctrl-C end either.
 */
function watchFlush(
  run: SyncMachineRun,
  ids: readonly string[],
  deadline: number,
  progress: Map<string, SyncLaneProgress>,
  flushed: Set<string>,
  phase: (next: SyncPhase) => void,
  note: (detail: string | undefined) => void
): Promise<FlushOutcome> {
  return new Promise((resolve) => {
    if (run.signal.aborted) {
      resolve({ kind: 'interrupted' })
      return
    }
    let handle: SyncFlushHandle | undefined
    const downSince = new Map<string, number>()
    let settled = false
    /** `exited` = the flush child itself finished; otherwise a running flush is killed. */
    const settle = (outcome: FlushOutcome, exited = false): void => {
      if (settled) {return}
      settled = true
      clearTimeout(timer)
      run.signal.removeEventListener('abort', onAbort)
      unsubscribe()
      if (!exited) {handle?.kill()}
      resolve(outcome)
    }
    // Why: a timer can fire a millisecond before Date.now() reaches the deadline (a 1 s cap
    // then reports 0.9 s); re-arm for the remainder so the cap is never cut short.
    const armDeadline = (): ReturnType<typeof setTimeout> | undefined => Number.isFinite(deadline)
      ? setTimeout(() => { if (run.now() < deadline) {timer = armDeadline()} else {settle({ kind: 'timeout' })} }, Math.max(0, deadline - run.now()))
      : undefined
    let timer = armDeadline()
    const onAbort = (): void => settle({ kind: 'interrupted' })
    run.signal.addEventListener('abort', onAbort, { once: true })
    let answeredAt = run.now()
    let silent = false
    const unsubscribe = run.poller.subscribe((sessions) => {
      if (settled) {return}
      if (sessions === undefined) {
        // A busy daemon (or a loaded Mac) is not a hung machine: keep waiting, bounded only by
        // the --timeout cap and the flush child itself, and say why the board is quiet.
        silent = true
        const quiet = run.now() - answeredAt
        if (quiet >= run.busyNoteMs) {note(`Mutagen busy · no status for ${formatDuration(coarse(quiet))}`)}
        return
      }
      const answered = run.now()
      if (silent) {
        // The stall rule counts only time the daemon REPORTED an endpoint down, not its silence.
        const gap = answered - answeredAt
        for (const [id, since] of downSince) {downSince.set(id, since + gap)}
        silent = false
        note(undefined)
      }
      answeredAt = answered
      const mine = sessions.filter((session) => ids.includes(session.id))
      const lanePhase = machinePhaseOf(applyProgress(run, mine, progress, flushed))
      if (lanePhase !== undefined) {phase(lanePhase)}
      const missing = ids.filter((id) => !mine.some((session) => session.id === id))
      if (missing.length > 0) {
        settle({ kind: 'error', message: `Mutagen session(s) disappeared mid-sync: ${missing.join(', ')}` })
        return
      }
      const halted = mine.find((session) => isHaltedStatus(session.status))
      if (halted) {
        settle({ kind: 'error', message: `${halted.name ?? halted.id} ${halted.status}${halted.lastError ? `: ${halted.lastError}` : ''}` })
        return
      }
      const at = run.now()
      for (const session of mine) {
        // A session whose flush already completed is done for this run, connected or not.
        if (flushed.has(session.id) || !isDisconnected(session)) {downSince.delete(session.id)} else if (!downSince.has(session.id)) {downSince.set(session.id, at)}
      }
      const longest = Math.max(0, ...[...downSince.values()].map((since) => at - since))
      if (downSince.size > 0 && longest >= run.stallGraceMs) {
        settle({ kind: 'stalled', detail: `no connection for ${seconds(longest)}` })
        return
      }
      if (handle === undefined && downSince.size === 0) {
        const started = run.mutagen.flush(ids, (id) => flushed.add(id))
        handle = started
        void started.done.then((result) => settle(result.ok ? { kind: 'ok' } : { kind: 'error', message: result.message }, true))
      }
    })
  })
}

/** Status polls failing in a row this long earn the muted `Mutagen busy` note. */
export const SYNC_BUSY_NOTE_MS = 10_000

/** The busy clock ticks in 10 s steps for the first minute, then per minute, so plain output stays short. */
function coarse(ms: number): number {
  const step = ms < 60_000 ? 10_000 : 60_000
  return Math.floor(ms / step) * step
}

/** Recomputes every lane from a poll, emits the lanes that changed, returns each lane's phase. */
function applyProgress(run: SyncMachineRun, sessions: readonly SyncSessionSnapshot[], progress: Map<string, SyncLaneProgress>, flushed: ReadonlySet<string>): SyncPhase[] {
  return run.target.machine.lanes.map((lane) => {
    const members = sessions.filter((session) => lane.sessionIds.includes(session.id))
    if (members.length === 0) {return progress.get(lane.key)?.phase ?? 'connecting'}
    const next = laneProgressOf(members, flushed)
    if (JSON.stringify(next) !== JSON.stringify(progress.get(lane.key))) {
      progress.set(lane.key, next)
      run.emit({ type: 'lane-progress', machineKey: run.target.machine.key, laneKey: lane.key, progress: next })
    }
    return next.phase
  })
}

/** One fresh read after the flush so the outcome carries final file/conflict/problem counts. */
async function refreshProgress(run: SyncMachineRun, progress: Map<string, SyncLaneProgress>): Promise<void> {
  try {
    // Only reached after every flush completed: every lane is synced.
    applyProgress(run, await run.mutagen.list(), progress, new Set(run.target.machine.lanes.flatMap((lane) => lane.sessionIds)))
  } catch {
    // The last polled counts stand.
  }
}

function outcomeOf(
  target: SyncNowTarget,
  state: SyncMachineOutcome['state'],
  reason: SyncSkipReason | undefined,
  detail: string | undefined,
  elapsedMs: number,
  warnings: readonly string[],
  progress: ReadonlyMap<string, SyncLaneProgress>,
  flushed: ReadonlySet<string>
): SyncMachineOutcome {
  const lanes = target.machine.lanes.map((lane) => {
    const last = progress.get(lane.key)
    // A lane is done once its own sessions flushed, even if another lane later stalled or hit the cap.
    const laneState = state !== 'synced' && laneFlushed(lane.sessionIds, flushed) ? 'synced' : state
    return { laneKey: lane.key, state: laneState, conflicts: last?.conflicts ?? 0, problems: last?.problems ?? 0, ...(last?.files === undefined ? {} : { files: last.files }) }
  })
  return {
    machineKey: target.machine.key,
    state,
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    elapsedMs: Math.max(0, elapsedMs),
    conflicts: lanes.reduce((sum, lane) => sum + lane.conflicts, 0),
    problems: lanes.reduce((sum, lane) => sum + lane.problems, 0),
    warnings: [...warnings],
    lanes
  }
}

function laneFlushed(ids: readonly string[], flushed: ReadonlySet<string>): boolean {
  return ids.length > 0 && ids.every((id) => flushed.has(id))
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`
}

export function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? '')
  return message.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)?.replace(/\s+/gu, ' ') ?? ''
}
