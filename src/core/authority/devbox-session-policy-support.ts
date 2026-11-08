import {
  createDevboxAuthorityError,
  type DevboxAuthorityError,
  type DevboxAuthorityEpochCheck
} from './devbox-authority-witness'
import type {
  DevboxAuthorityEpochRecord,
  DevboxAuthorityOwner,
  DevboxOperationEnvelope,
  DevboxOperationPhase
} from '../../shared/devbox-types'
import type { DevboxOperationJournal } from '../devbox-operation-journal'
import type { DevboxPathMapper } from '../devbox-path-mapper'
import type { DevboxAuthorityEpochManager } from './devbox-authority-epoch'

// The adapter owns scanRemoteAiVaultSessions; this policy only consumes discovery records.
export type DevboxSessionDiscoveryRecord = Readonly<{ sessionPath: string; changed: boolean }>
export type DevboxSessionDiscovery = {
  discover: (input: {
    sessionPath: string
    authorityOwner: DevboxAuthorityOwner
  }) => Promise<readonly DevboxSessionDiscoveryRecord[]>
}
export type DevboxPhiProcessEvidence = Readonly<{
  pid: number | null
  command: string
  ownership: 'managed' | 'unmanaged' | 'unknown'
  phi: 'confirmed' | 'not-phi' | 'unknown'
}>
export type DevboxManagedJobEvidence = Readonly<{
  jobId: string
  kind: string
  state: 'running' | 'stopped' | 'unknown'
  phi: 'confirmed' | 'not-phi' | 'unknown'
  pid?: number
}>
export type DevboxSessionProcessInventory = Readonly<{
  status: 'complete' | 'unknown'
  processes: readonly DevboxPhiProcessEvidence[]
  managedJobs: readonly DevboxManagedJobEvidence[]
  reason?: string
}>
export type DevboxSessionProcessInspector = {
  inspect: (input: {
    sessionPath: string
    authorityEpoch: DevboxAuthorityEpochRecord
    operationId: string
  }) => Promise<DevboxSessionProcessInventory>
}
export type DevboxSessionFileSystem = {
  readJsonl: (path: string) => Promise<string>
  archive: (input: { sourcePath: string; archivePath: string; content: string }) => Promise<void>
  fork: (input: { sourcePath: string; forkPath: string; content: string }) => Promise<void>
}
export type DevboxSessionPolicyClock = {
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
}
export type DevboxSessionPolicyOptions = {
  journal: Pick<DevboxOperationJournal, 'append'>
  authority: Pick<DevboxAuthorityEpochManager, 'validateEpoch'>
  pathMapper: Pick<DevboxPathMapper, 'map' | 'unmap'>
  discovery: DevboxSessionDiscovery
  processes: DevboxSessionProcessInspector
  filesystem: DevboxSessionFileSystem
  clock: DevboxSessionPolicyClock
  observation?: { windowMs?: number; sampleIntervalMs?: number; maxSamples?: number }
}
export type DevboxSessionPolicyRequest = {
  operationId: string
  idempotencyKey: string
  sessionPath: string
  authorityEpoch: DevboxAuthorityEpochRecord
  targetOwner: DevboxAuthorityOwner
}
export type DevboxSessionPolicyBlocked = {
  status: 'blocked'
  error: DevboxAuthorityError
  inventory?: DevboxSessionProcessInventory
}
export type DevboxPreparedSession = {
  request: DevboxSessionPolicyRequest
  discovery: DevboxSessionDiscoveryRecord
  inventory: DevboxSessionProcessInventory
  startedAt: number
}
type SessionInventory = { sessionPath: string; inventory: DevboxSessionProcessInventory }
type ArchivedSession = SessionInventory & { status: 'archived'; archivePath: string }
type ForkedSession = SessionInventory & { status: 'forked'; forkPath: string }
export type DevboxSessionArchiveResult =
  | ArchivedSession
  | (SessionInventory & { status: 'unchanged' })
  | DevboxSessionPolicyBlocked
export type DevboxSessionOpenResult =
  | (SessionInventory & { status: 'attached' })
  | ForkedSession
  | DevboxSessionPolicyBlocked

export type DevboxStableJsonlResult =
  | { status: 'stable'; content: string }
  | { status: 'read-error'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'unstable' }

export async function readStableJsonl(input: {
  path: string
  filesystem: DevboxSessionFileSystem
  clock: DevboxSessionPolicyClock
  startedAt: number
  observation?: DevboxSessionPolicyOptions['observation']
}): Promise<DevboxStableJsonlResult> {
  const windowMs = input.observation?.windowMs ?? 100
  const intervalMs = input.observation?.sampleIntervalMs ?? 20
  const maxSamples = input.observation?.maxSamples ?? 5
  let previous: string
  try {
    previous = await input.filesystem.readJsonl(input.path)
  } catch (error) {
    return { status: 'read-error', message: String(error) }
  }
  if (!isValidJsonl(previous)) {
    return { status: 'invalid', message: 'The session JSONL is invalid.' }
  }
  for (let sample = 1; sample <= maxSamples; sample += 1) {
    const elapsed = input.clock.now() - input.startedAt
    if (elapsed >= windowMs) {
      break
    }
    await input.clock.sleep(Math.min(intervalMs, Math.max(1, windowMs - elapsed)))
    let current: string
    try {
      current = await input.filesystem.readJsonl(input.path)
    } catch (error) {
      return { status: 'read-error', message: String(error) }
    }
    if (!isValidJsonl(current)) {
      return { status: 'invalid', message: 'The session JSONL is invalid.' }
    }
    if (current === previous) {
      return { status: 'stable', content: current }
    }
    previous = current
  }
  return { status: 'unstable' }
}

export function sessionOperation(
  request: DevboxSessionPolicyRequest,
  phase: DevboxOperationPhase,
  startedAt: number,
  now: number
): DevboxOperationEnvelope {
  const completed = phase === 'completed'
  return {
    operationId: `${request.operationId}:${phase}`,
    kind: 'handoff',
    phase,
    idempotencyKey: request.idempotencyKey,
    cancellation: { requested: false },
    timestamps: { startedAt, updatedAt: now },
    authorityEpoch: request.authorityEpoch,
    status: {
      execution: { side: request.authorityEpoch.owner, state: completed ? 'completed' : 'paused' },
      authority: { side: request.authorityEpoch.owner, state: completed ? 'owner' : 'quiesced' },
      freshness: { state: 'fresh', observedAt: now },
      conflict: { state: 'none' },
      drift: { state: 'none' },
      connectivity: { state: 'online' },
      auth: { state: 'healthy' },
      disk: { state: 'healthy' }
    }
  }
}

export function processEvidence(
  inventory: DevboxSessionProcessInventory,
  processes = inventory.processes.filter((process) => process.phi !== 'not-phi'),
  jobs = inventory.managedJobs.filter(
    (job) => (job.kind === 'phi' || job.phi !== 'not-phi') && job.state !== 'stopped'
  )
): string {
  return JSON.stringify({
    status: inventory.status,
    reason: inventory.reason ?? null,
    pids: processes.map((process) => process.pid),
    processes,
    managedJobs: jobs
  })
}

export function policyError(
  path: string,
  reason: string,
  remediation: string,
  code: DevboxAuthorityError['code'],
  evidence: string
): DevboxAuthorityError {
  return createDevboxAuthorityError(
    code,
    `Session path ${path} is blocked: ${reason} Remediation: ${remediation}`,
    ['journal_unavailable', 'transition_blocked', 'writer_not_acknowledged'].includes(code),
    path,
    { sessionPath: path, processEvidence: evidence, remediation }
  )
}

export function processBlocker(
  path: string,
  inventory: DevboxSessionProcessInventory
): DevboxAuthorityError | undefined {
  if (inventory.status !== 'complete') {
    return policyError(
      path,
      `Process inspection is inconclusive${inventory.reason ? `: ${inventory.reason}` : '.'}`,
      'Treat Phi as present, keep the session on its authority, and retry after inspection is complete.',
      'transition_blocked',
      processEvidence(inventory)
    )
  }
  const processes = inventory.processes.filter((process) => process.phi !== 'not-phi')
  const jobs = inventory.managedJobs.filter(
    (job) => (job.kind === 'phi' || job.phi !== 'not-phi') && job.state !== 'stopped'
  )
  return processes.length === 0 && jobs.length === 0
    ? undefined
    : policyError(
        path,
        'A managed or conservatively detected Phi writer is present.',
        'Stop or reattach Phi on the current authority, then retry after a clean inventory.',
        'writer_not_acknowledged',
        processEvidence(inventory, processes, jobs)
      )
}

export function mappedTargetPath(
  options: Pick<DevboxSessionPolicyOptions, 'pathMapper'>,
  request: DevboxSessionPolicyRequest
): string | DevboxAuthorityError {
  if (request.targetOwner === request.authorityEpoch.owner) {
    return policyError(
      request.sessionPath,
      'Archival or forking requires a different target authority.',
      'Transfer authority first, then retry the session operation.',
      'transition_blocked',
      'not-inspected'
    )
  }
  const mapped =
    request.authorityEpoch.owner === 'local'
      ? options.pathMapper.map(request.sessionPath)
      : options.pathMapper.unmap(request.sessionPath)
  if (mapped.status !== 'mapped' || mapped.mappedPath === request.sessionPath) {
    const reason =
      mapped.status === 'mapped' ? 'the mapped destination equals the source' : mapped.error.message
    return policyError(
      request.sessionPath,
      `The session path cannot be relocated: ${reason}.`,
      'Fix the explicit Devbox path map and retry without opening the source JSONL elsewhere.',
      'transition_blocked',
      'process inventory was clear before path mapping'
    )
  }
  return mapped.mappedPath
}

export function stabilityError(
  path: string,
  result: Exclude<DevboxStableJsonlResult, { status: 'stable' }>
): DevboxAuthorityError {
  const reason =
    result.status === 'unstable'
      ? 'The session JSONL did not remain unchanged during the bounded observation window.'
      : result.status === 'invalid'
        ? result.message
        : `The session JSONL could not be read: ${result.message}.`
  const remediation =
    result.status === 'unstable' || result.status === 'invalid'
      ? 'Leave the session on its authority and retry after Phi has stopped writing and the JSONL is valid.'
      : 'Keep the session on its authority and retry after the file is readable.'
  return policyError(
    path,
    reason,
    remediation,
    result.status === 'unstable' ? 'external_drift' : 'transition_blocked',
    'process inventory was clear before read'
  )
}

export function epochError(
  path: string,
  check: Extract<DevboxAuthorityEpochCheck, { status: 'rejected' }>
): DevboxAuthorityError {
  return policyError(
    path,
    check.error.message,
    'Retry from the current authority epoch without opening or archiving this session.',
    check.error.code,
    'not-inspected'
  )
}

function isValidJsonl(content: string): boolean {
  try {
    content
      .split('\n')
      .filter((line) => line.trim())
      .forEach((line) => JSON.parse(line))
    return true
  } catch {
    return false
  }
}
