import type {
  SyncLane,
  SyncLaneProgress,
  SyncMachine,
  SyncMachineOutcome,
  SyncNowEvent,
  SyncNowPlan,
  SyncNowResult,
  SyncPhase
} from './sync-now-types'
import { oneLine } from './sync-now-render-format'

/**
 * Renderer-side view of a `db sync` run, folded from SyncNowEvent values. Both
 * the live board and the plain line log read this; neither keeps its own copy.
 */

export type LaneView = {
  lane: SyncLane
  phase: SyncPhase
  phaseSince: number
  progress?: SyncLaneProgress
  /** Largest staging batch seen (files / bytes): what this run actually moved. */
  movedFiles: number
  movedBytes: number
  sawTransfer: boolean
}

export type MachineView = {
  machine: SyncMachine
  phase: SyncPhase
  phaseSince: number
  /** When the machine left `queued` (the plan start unless it was queued). */
  startedAt: number
  detail?: string
  /** Latest non-fatal warning for this machine. */
  warning?: string
  lanes: LaneView[]
  outcome?: SyncMachineOutcome
}

export type RunView = {
  plan?: SyncNowPlan
  startedAt?: number
  machines: MachineView[]
  lockWait?: { pid: number; since: number; holderStartedAt?: number; command?: string }
  globalWarning?: string
  result?: SyncNowResult
}

export type MachineStatus = 'queued' | 'active' | 'synced' | 'skipped' | 'failed'

const TERMINAL: ReadonlySet<SyncPhase> = new Set(['synced', 'skipped', 'failed'])

export function isTerminalPhase(phase: SyncPhase): boolean {
  return TERMINAL.has(phase)
}

export function createRunView(): RunView {
  return { machines: [] }
}

export function findMachine(view: RunView, key: string): MachineView | undefined {
  return view.machines.find((entry) => entry.machine.key === key)
}

export function applySyncEvent(view: RunView, event: SyncNowEvent, now: number): void {
  switch (event.type) {
    case 'lock-wait':
      if (view.lockWait?.pid !== event.holderPid) {
        view.lockWait = { pid: event.holderPid, since: now, holderStartedAt: event.holderStartedAt, command: event.holderCommand }
      }
      return
    case 'plan':
      view.lockWait = undefined
      view.plan = event.plan
      view.startedAt = Number.isFinite(event.plan.startedAt) ? event.plan.startedAt : now
      view.machines = event.plan.machines.map((machine) => ({
        machine,
        phase: 'queued',
        phaseSince: now,
        startedAt: view.startedAt ?? now,
        lanes: machine.lanes.map((lane) => ({ lane, phase: 'queued', phaseSince: now, movedFiles: 0, movedBytes: 0, sawTransfer: false }))
      }))
      return
    case 'machine-phase':
      applyMachinePhase(view, event.machineKey, event.phase, event.detail, now)
      return
    case 'lane-progress':
      applyLaneProgress(view, event.machineKey, event.laneKey, event.progress, now)
      return
    case 'machine-done':
      applyOutcome(view, event.outcome, now)
      return
    case 'warning': {
      const message = oneLine(event.message)
      const target = event.machineKey === undefined ? undefined : findMachine(view, event.machineKey)
      if (target === undefined) {
        view.globalWarning = message
      } else {
        target.warning = message
      }
      return
    }
    case 'finished':
      view.lockWait = undefined
      view.result = event.result
      for (const outcome of event.result.machines) {
        const entry = findMachine(view, outcome.machineKey)
        if (entry !== undefined && entry.outcome === undefined) {applyOutcome(view, outcome, now)}
      }
  }
}

function applyMachinePhase(view: RunView, key: string, phase: SyncPhase, detail: string | undefined, now: number): void {
  const entry = findMachine(view, key)
  if (entry === undefined || entry.outcome !== undefined) {return}
  if (entry.phase === 'queued' && phase !== 'queued' && now - entry.phaseSince >= 1000) {
    // A machine that really sat in a queue starts its clock when it begins.
    entry.startedAt = now
  }
  if (entry.phase !== phase) {entry.phaseSince = now}
  entry.phase = phase
  entry.detail = detail === undefined ? undefined : oneLine(detail)
}

function applyLaneProgress(view: RunView, machineKey: string, laneKey: string, progress: SyncLaneProgress, now: number): void {
  const entry = findMachine(view, machineKey)
  const lane = entry?.lanes.find((candidate) => candidate.lane.key === laneKey)
  if (entry === undefined || lane === undefined || entry.outcome !== undefined) {return}
  if (lane.phase !== progress.phase) {lane.phaseSince = now}
  lane.phase = progress.phase
  lane.progress = progress
  if (progress.phase === 'transferring') {lane.sawTransfer = true}
  const staging = progress.staging
  if (staging !== undefined) {
    lane.sawTransfer = true
    lane.movedFiles = Math.max(lane.movedFiles, staging.expectedFiles, staging.receivedFiles)
    lane.movedBytes = Math.max(lane.movedBytes, staging.expectedBytes ?? 0, staging.receivedBytes)
  }
}

function applyOutcome(view: RunView, outcome: SyncMachineOutcome, now: number): void {
  const entry = findMachine(view, outcome.machineKey)
  if (entry === undefined) {return}
  if (entry.phase !== outcome.state) {entry.phaseSince = now}
  entry.outcome = outcome
  entry.phase = outcome.state
  const warning = outcome.warnings.at(-1)
  if (warning !== undefined) {entry.warning = oneLine(warning)}
  for (const result of outcome.lanes) {
    const lane = entry.lanes.find((candidate) => candidate.lane.key === result.laneKey)
    if (lane === undefined) {continue}
    // A lane's final state starts its own clock: a skipped lane must not show the run's age.
    if (lane.phase !== result.state) {lane.phaseSince = now}
    lane.phase = result.state
    lane.progress = {
      ...lane.progress,
      phase: result.state,
      conflicts: result.conflicts,
      problems: result.problems,
      files: result.files ?? lane.progress?.files
    }
  }
}

export function machineStatus(entry: MachineView): MachineStatus {
  if (entry.outcome !== undefined) {return entry.outcome.state}
  if (entry.phase === 'queued') {return 'queued'}
  if (entry.phase === 'synced' || entry.phase === 'skipped' || entry.phase === 'failed') {return entry.phase}
  return 'active'
}

export function machineElapsed(entry: MachineView, now: number): number {
  if (entry.outcome !== undefined) {return entry.outcome.elapsedMs}
  return Math.max(0, now - entry.startedAt)
}

export type StagingTotals = { received: number; expected: number; bytes: number; expectedBytes?: number }

/** Staging summed over the lanes that are transferring right now. */
export function stagingTotals(lanes: readonly LaneView[]): StagingTotals | undefined {
  const staging = lanes.flatMap((lane) => lane.phase === 'transferring' && lane.progress?.staging !== undefined ? [lane.progress.staging] : [])
  if (staging.length === 0) {return undefined}
  const known = staging.every((item) => item.expectedBytes !== undefined)
  return {
    received: staging.reduce((sum, item) => sum + item.receivedFiles, 0),
    expected: staging.reduce((sum, item) => sum + item.expectedFiles, 0),
    bytes: staging.reduce((sum, item) => sum + item.receivedBytes, 0),
    ...(known ? { expectedBytes: staging.reduce((sum, item) => sum + (item.expectedBytes ?? 0), 0) } : {})
  }
}

/** Fraction done by bytes when the total is known, else by files. */
export function stagingFraction(totals: StagingTotals): number | undefined {
  if (totals.expectedBytes !== undefined && totals.expectedBytes > 0) {return totals.bytes / totals.expectedBytes}
  return totals.expected > 0 ? totals.received / totals.expected : undefined
}

export function conflictCounts(entry: MachineView): { conflicts: number; problems: number } {
  if (entry.outcome !== undefined) {return { conflicts: entry.outcome.conflicts, problems: entry.outcome.problems }}
  return entry.lanes.reduce((sum, lane) => ({
    conflicts: sum.conflicts + (lane.progress?.conflicts ?? 0),
    problems: sum.problems + (lane.progress?.problems ?? 0)
  }), { conflicts: 0, problems: 0 })
}

export type Tally = { synced: number; skipped: number; failed: number; running: number; queued: number }

export function tally(view: RunView): Tally {
  const counts: Tally = { synced: 0, skipped: 0, failed: 0, running: 0, queued: 0 }
  for (const entry of view.machines) {
    const status = machineStatus(entry)
    if (status === 'active') {counts.running += 1} else {counts[status] += 1}
  }
  return counts
}

/** What a finished machine was seen moving, for `synced · 3 files · 182 MB` (or plain `synced`). */
export function movedSummary(entry: MachineView): { files: number; bytes: number; changed: boolean } {
  return {
    files: entry.lanes.reduce((sum, lane) => sum + lane.movedFiles, 0),
    bytes: entry.lanes.reduce((sum, lane) => sum + lane.movedBytes, 0),
    changed: entry.lanes.some((lane) => lane.sawTransfer)
  }
}

/** `another db sync`, or the other command that holds the run lock (`db mutagen restart`). */
export function lockHolderText(command: string | undefined): string {
  return command === undefined || command === 'db sync' ? 'another db sync' : command
}
