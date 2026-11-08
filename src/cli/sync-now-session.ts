import type { SyncLaneProgress, SyncPhase } from './sync-now-types'

/**
 * The slice of one `mutagen sync list --template '{{json .}}'` entry that `db sync`
 * needs (Mutagen v0.18 JSON). Every count is defensive: Mutagen omits zero values.
 */
export type SyncStagingSnapshot = {
  path?: string
  receivedFiles: number
  expectedFiles: number
  totalReceivedSize: number
}

export type SyncEndpointSnapshot = {
  protocol: string
  user?: string
  host?: string
  /** Absent in Mutagen JSON when the URL carried no port. */
  port?: number
  path?: string
  connected: boolean
  scanned: boolean
  files?: number
  staging?: SyncStagingSnapshot
  /** scanProblems + transitionProblems, including the excluded (truncated) counts. */
  problems: number
}

export type SyncSessionSnapshot = {
  id: string
  name?: string
  labels: Readonly<Record<string, string>>
  status: string
  paused: boolean
  successfulCycles: number
  /** conflicts + excludedConflicts. */
  conflicts: number
  lastError?: string
  alpha: SyncEndpointSnapshot
  beta: SyncEndpointSnapshot
}

export function parseSyncSessions(json: string): SyncSessionSnapshot[] {
  const text = json.trim()
  if (!text) {return []}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text.split(/\r?\n/u).filter(Boolean).map((row) => JSON.parse(row) as unknown)
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.flatMap((entry) => {
    const session = toSession(entry)
    return session ? [session] : []
  })
}

function toSession(value: unknown): SyncSessionSnapshot | undefined {
  if (!isRecord(value) || typeof value.identifier !== 'string' || value.identifier.length === 0) {return undefined}
  const labels = isRecord(value.labels)
    ? Object.fromEntries(Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  const lastError = text(value.lastError)
  return {
    id: value.identifier,
    ...(text(value.name) === undefined ? {} : { name: text(value.name) }),
    labels,
    status: text(value.status) ?? 'unknown',
    paused: value.paused === true,
    successfulCycles: count(value.successfulCycles),
    conflicts: length(value.conflicts) + count(value.excludedConflicts),
    ...(lastError === undefined ? {} : { lastError }),
    alpha: toEndpoint(value.alpha),
    beta: toEndpoint(value.beta)
  }
}

function toEndpoint(value: unknown): SyncEndpointSnapshot {
  const input = isRecord(value) ? value : {}
  const port = count(input.port)
  const staging = isRecord(input.stagingProgress) ? input.stagingProgress : undefined
  return {
    protocol: text(input.protocol) ?? 'unknown',
    ...(text(input.user) === undefined ? {} : { user: text(input.user) }),
    ...(text(input.host) === undefined ? {} : { host: text(input.host) }),
    ...(port > 0 ? { port } : {}),
    ...(text(input.path) === undefined ? {} : { path: text(input.path) }),
    connected: input.connected === true,
    scanned: input.scanned === true,
    ...(typeof input.files === 'number' ? { files: count(input.files) } : {}),
    ...(staging === undefined ? {} : {
      staging: {
        ...(text(staging.path) === undefined ? {} : { path: text(staging.path) }),
        receivedFiles: count(staging.receivedFiles),
        expectedFiles: count(staging.expectedFiles),
        totalReceivedSize: count(staging.totalReceivedSize)
      }
    }),
    problems: length(input.scanProblems) + count(input.excludedScanProblems) +
      length(input.transitionProblems) + count(input.excludedTransitionProblems)
  }
}

const PHASE_RANK: Partial<Record<SyncPhase, number>> = {
  connecting: 0,
  scanning: 1,
  reconciling: 2,
  transferring: 3,
  saving: 4,
  synced: 5
}

/** True for Mutagen's `halted-on-root-*` states: the session stopped and needs a human. */
export function isHaltedStatus(status: string): boolean {
  return status.startsWith('halted')
}

/** True while either endpoint is down: disconnected, still connecting, or reported unconnected. */
export function isDisconnected(session: SyncSessionSnapshot): boolean {
  if (isHaltedStatus(session.status)) {return false}
  return session.status === 'disconnected' || session.status.startsWith('connecting') || !session.alpha.connected || !session.beta.connected
}

/**
 * Mutagen status → user-facing phase. A session is synced for this run once its own
 * `sync flush` completed, and stays synced: cycles that later file changes trigger are
 * background work. Before that, `watching` means the flush cycle is about to scan.
 */
export function sessionPhase(session: SyncSessionSnapshot, flushed = false): SyncPhase {
  const status = session.status
  if (isHaltedStatus(status)) {return 'failed'}
  if (flushed) {return 'synced'}
  if (status === 'watching') {return 'scanning'}
  if (status === 'scanning' || status === 'waiting-for-rescan') {return 'scanning'}
  if (status === 'reconciling') {return 'reconciling'}
  if (status.startsWith('staging') || status === 'transitioning') {return 'transferring'}
  if (status === 'saving') {return 'saving'}
  return 'connecting'
}

/**
 * Folds a lane's sessions into one progress value (least-advanced session wins the phase).
 * A lane's sessions mirror the same root pair (portable-declarative + portable-working),
 * so file, conflict, and problem counts take the largest session's, not the sum.
 */
export function laneProgressOf(
  sessions: readonly SyncSessionSnapshot[],
  flushed: ReadonlySet<string> = new Set()
): SyncLaneProgress {
  let phase: SyncPhase = 'synced'
  let mutagenStatus: string | undefined
  let rank = Number.POSITIVE_INFINITY
  let conflicts = 0
  let problems = 0
  let files: number | undefined
  let lastError: string | undefined
  let staging: SyncLaneProgress['staging']
  for (const session of sessions) {
    const current = sessionPhase(session, flushed.has(session.id))
    const currentRank = current === 'failed' ? -1 : PHASE_RANK[current] ?? 0
    if (currentRank < rank) {
      rank = currentRank
      phase = current
      mutagenStatus = session.status
    }
    conflicts = Math.max(conflicts, session.conflicts)
    problems = Math.max(problems, session.alpha.problems + session.beta.problems)
    if (session.alpha.scanned && session.alpha.files !== undefined) {files = Math.max(files ?? 0, session.alpha.files)}
    lastError ??= session.lastError
    for (const side of [session.alpha.staging, session.beta.staging]) {
      if (side === undefined) {continue}
      staging = {
        receivedFiles: (staging?.receivedFiles ?? 0) + side.receivedFiles,
        expectedFiles: (staging?.expectedFiles ?? 0) + side.expectedFiles,
        receivedBytes: (staging?.receivedBytes ?? 0) + side.totalReceivedSize,
        ...(staging?.path ?? side.path ? { path: staging?.path ?? side.path } : {})
      }
    }
  }
  return {
    phase: sessions.length === 0 ? 'connecting' : phase,
    ...(mutagenStatus === undefined ? {} : { mutagenStatus }),
    ...(staging === undefined || phase !== 'transferring' ? {} : { staging }),
    ...(files === undefined ? {} : { files }),
    conflicts,
    problems,
    ...(lastError === undefined ? {} : { lastError })
  }
}

/** Least-advanced phase across lanes, ignoring lanes that already finished their cycle. */
export function machinePhaseOf(phases: readonly SyncPhase[]): SyncPhase | undefined {
  let best: SyncPhase | undefined
  for (const phase of phases) {
    if (phase === 'synced' || PHASE_RANK[phase] === undefined) {continue}
    if (best === undefined || (PHASE_RANK[phase] ?? 0) < (PHASE_RANK[best] ?? 0)) {best = phase}
  }
  return best
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function length(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
