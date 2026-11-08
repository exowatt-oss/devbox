import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxOperationJournal } from '../core/devbox-operation-journal'
import type {
  DevboxSyncBackend,
  DevboxSyncConflict,
  DevboxSyncCreateRequest,
  DevboxSyncStatus
} from './devbox-sync-backend'
import type {
  DevboxSyncSupervisorOptions,
  DevboxSyncSupervisorState,
  DevboxSyncSupervisorStatus
} from './devbox-sync-supervisor-contract'
import {
  createBackend,
  createObservationBackend
} from './devbox-sync-supervisor-backend'
import { terminateOwnedSessionsForDisable } from './devbox-sync-supervisor-disable'
import { record } from './devbox-sync-supervisor-journal'
import { emitStatus } from './devbox-sync-supervisor-events'
import {
  emptyStatus,
  haltedStatus,
  sloFor,
  watchModeFor
} from './devbox-sync-supervisor-status'
export type SupervisorRuntime = {
  readonly profileId: string
  readonly requests: readonly DevboxSyncCreateRequest[]
  readonly journal: DevboxOperationJournal | undefined
  readonly options: DevboxSyncSupervisorOptions
  readonly now: () => number
  readonly tail: { promise: Promise<void> }
  readonly backends: Map<string, DevboxSyncBackend>
  timer: ReturnType<typeof setInterval> | undefined
  started: boolean
  fallbackDegradation: DevboxSyncSupervisorStatus['degradation']
  statusValue: DevboxSyncSupervisorStatus
  lastEmittedAt: number
  lastSignature: string
}

export function createSupervisorRuntime(options: DevboxSyncSupervisorOptions): SupervisorRuntime {
  const now = options.now ?? Date.now
  return {
    profileId: options.profileId,
    requests: Object.freeze([...options.requests]),
    journal: options.journal,
    options,
    now,
    tail: { promise: Promise.resolve() },
    backends: new Map(),
    timer: undefined,
    started: false,
    fallbackDegradation: undefined,
    statusValue: {
      ...emptyStatus(options.profileId, now()),
      state: 'stopped'
    },
    lastEmittedAt: 0,
    lastSignature: ''
  }
}
export function start(runtime: SupervisorRuntime): Promise<DevboxSyncSupervisorStatus> {
  return enqueue(runtime, async () => {
    if (runtime.started) {
      return runtime.statusValue
    }
    runtime.statusValue = {
      ...runtime.statusValue,
      state: 'starting',
      observedAt: runtime.now()
    }
    record(runtime, 'preparing')
    const replay = runtime.journal?.replay()
    if (replay && replay.status !== 'ok') {
      throw replay.error ?? createDevboxError('journal_corrupt')
    }
    for (const request of runtime.requests) {
      const result = await createBackend(runtime.options, runtime.profileId, request)
      runtime.fallbackDegradation = result.fallbackDegradation ?? runtime.fallbackDegradation
      runtime.backends.set(request.sessionId, result.backend)
    }
    runtime.started = true
    startTimer(runtime)
    runtime.statusValue = await refreshStatus(runtime, false)
    record(runtime, 'ready')
    return runtime.statusValue
  })
}
export function status(runtime: SupervisorRuntime): Promise<DevboxSyncSupervisorStatus> {
  if (runtime.started) {
    return enqueue(runtime, () => refreshStatus(runtime, false))
  }
  return observe(runtime)
}
export function pause(runtime: SupervisorRuntime): Promise<void> {
  return bulk(runtime, async (backend) => backend.pause(), 'quiescing')
}
export function resume(runtime: SupervisorRuntime): Promise<void> {
  return bulk(runtime, async (backend) => backend.resume(), 'resuming')
}
export function flush(runtime: SupervisorRuntime): Promise<void> {
  return bulk(runtime, async (backend) => backend.flush(), 'checkpointing')
}
export function verify(runtime: SupervisorRuntime): Promise<DevboxSyncSupervisorStatus> {
  if (!runtime.started) {
    return Promise.resolve(runtime.statusValue)
  }
  return enqueue(runtime, () => refreshStatus(runtime, true))
}
export function listConflicts(runtime: SupervisorRuntime): Promise<readonly DevboxSyncConflict[]> {
  if (!runtime.started) {
    return Promise.resolve([])
  }
  return enqueue(runtime, async () => {
    const conflicts: DevboxSyncConflict[] = []
    for (const backend of runtime.backends.values()) {
      conflicts.push(...(await backend.listConflicts()))
    }
    return conflicts
  })
}
export async function shutdownForDisable(runtime: SupervisorRuntime): Promise<void> {
  await enqueue(runtime, async () => {
    runtime.statusValue = {
      ...runtime.statusValue,
      state: 'stopping',
      observedAt: runtime.now()
    }
    if (!runtime.started) {
      const observed = new Map<string, DevboxSyncBackend>()
      for (const request of runtime.requests) {
        const result = await createObservationBackend(runtime.options, runtime.profileId, request)
        runtime.fallbackDegradation = result.fallbackDegradation ?? runtime.fallbackDegradation
        observed.set(request.sessionId, result.backend)
      }
      runtime.backends.clear()
      for (const [sessionId, backend] of observed) {
        runtime.backends.set(sessionId, backend)
      }
    }
    await terminateOwnedSessionsForDisable(runtime)
    await runtime.options.onDisableCleanup?.()
    stopTimer(runtime)
    runtime.started = false
    runtime.backends.clear()
    runtime.statusValue = {
      ...runtime.statusValue,
      state: 'stopped',
      sessions: [],
      observedAt: runtime.now()
    }
    record(runtime, 'completed')
  })
}

export function dispose(runtime: SupervisorRuntime): Promise<void> {
  stopTimer(runtime)
  return enqueue(runtime, async () => {
    for (const backend of runtime.backends.values()) {
      const candidate = backend as DevboxSyncBackend & { dispose?: () => Promise<void> }
      if (candidate.dispose) {
        await candidate.dispose().catch(() => undefined)
      }
    }
    runtime.backends.clear()
    runtime.started = false
  })
}
async function observe(runtime: SupervisorRuntime): Promise<DevboxSyncSupervisorStatus> {
  return enqueue(runtime, async () => {
    const observed = new Map<string, DevboxSyncBackend>()
    for (const request of runtime.requests) {
      const result = await createObservationBackend(runtime.options, runtime.profileId, request)
      runtime.fallbackDegradation = result.fallbackDegradation ?? runtime.fallbackDegradation
      if (result.backend.observe) {
        await result.backend.observe(request)
      }
      observed.set(request.sessionId, result.backend)
    }
    return refreshStatus(runtime, false, observed, true)
  })
}

async function refreshStatus(
  runtime: SupervisorRuntime,
  emit: boolean,
  backends: ReadonlyMap<string, DevboxSyncBackend> = runtime.backends,
  liveObservation = false
): Promise<DevboxSyncSupervisorStatus> {
  const sessions: DevboxSyncStatus[] = []
  let degradation: DevboxSyncSupervisorStatus['degradation'] = runtime.fallbackDegradation
  for (const backend of backends.values()) {
    try {
      sessions.push(await backend.status())
    } catch {
      degradation = 'mutagen-error'
      sessions.push(haltedStatus(runtime.now()))
    }
  }
  const fallbackDegraded = sessions.some((session) => session.capability === 'degraded-directional')
  const sessionDegraded = sessions.some((session) => session.conflictCount > 0 || session.problemCount > 0 || session.lastError !== null)
  if (!degradation && sessionDegraded) {
    degradation = 'mutagen-error'
  }
  const degraded = fallbackDegraded || sessionDegraded
  const watchMode = watchModeFor(sessions)
  const target = sloFor(fallbackDegraded, watchMode)
  const conflictCount = sessions.reduce((total, session) => total + session.conflictCount, 0)
  const state: DevboxSyncSupervisorState =
    (!runtime.started && !liveObservation) ||
    (liveObservation && sessions.every((session) => session.session === null))
    ? 'stopped'
    : degraded
      ? 'degraded'
      : sessions.some((session) => session.phase === 'paused')
        ? 'paused'
        : 'running'
  const next: DevboxSyncSupervisorStatus = {
    profileId: runtime.profileId,
    state,
    sessions,
    capability:
      sessions.length === 0 ? 'unavailable' : fallbackDegraded ? 'degraded-directional' : 'two-way-safe',
    watchMode,
    sloTarget: target,
    conflictCount,
    backpressure: { bulkConcurrency: 1, queuedOperations: 0 },
    ...(degradation ? { degradation } : {}),
    observedAt: runtime.now()
  }
  runtime.statusValue = next
  if (emit) {
    emitStatus(runtime, next)
  }
  return next
}

function bulk(
  runtime: SupervisorRuntime,
  operation: (backend: DevboxSyncBackend) => Promise<void>,
  phase: string
): Promise<void> {
  if (!runtime.started) {
    return Promise.resolve()
  }
  return enqueue(runtime, async () => {
    record(runtime, phase)
    for (const backend of runtime.backends.values()) {
      await operation(backend)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    runtime.statusValue = await refreshStatus(runtime, true)
  })
}

function enqueue<T>(runtime: SupervisorRuntime, operation: () => Promise<T>): Promise<T> {
  const next = runtime.tail.promise.then(operation, operation)
  runtime.tail.promise = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function startTimer(runtime: SupervisorRuntime): void {
  if (runtime.timer || (runtime.options.statusIntervalMs ?? 1_000) <= 0) {
    return
  }
  runtime.timer = setInterval(() => {
    void enqueue(runtime, () => refreshStatus(runtime, true)).catch(() => undefined)
  }, runtime.options.statusIntervalMs ?? 1_000)
  runtime.timer.unref?.()
}

function stopTimer(runtime: SupervisorRuntime): void {
  if (runtime.timer) {
    clearInterval(runtime.timer)
    runtime.timer = undefined
  }
}
