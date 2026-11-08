import { createHash } from 'node:crypto'
import { createDevboxError, type DevboxError } from '../../shared/devbox-errors'
import {
  isDevboxAuthorityEpochRecord,
  type DevboxAuthorityEpochRecord
} from '../../shared/devbox-types'
import { createDevboxAuthorityError, type DevboxAuthorityError } from './devbox-authority-witness'

export type DevboxGitShadowCommand = { cwd: string; args: readonly string[]; stdin?: string }
export type DevboxGitShadowCommandResult = { exitCode: number; stdout?: string }
export type DevboxGitShadowRunner = {
  run(command: DevboxGitShadowCommand): Promise<DevboxGitShadowCommandResult>
}
export type DevboxGitShadowFiles = {
  write(path: string, contents: string, mode?: number): Promise<void>
}
export type DevboxGitShadowRef = { name: string; objectId: string }
export type DevboxGitShadowInput = {
  profileId: string
  repositoryId: string
  operationId: string
  sourcePath: string
  shadowPath: string
  reflogPath: string
  authority: DevboxAuthorityEpochRecord
  refs: readonly DevboxGitShadowRef[]
  detachedObjectIds?: readonly string[]
  reflogRecovery?: readonly string[]
}
export type DevboxGitShadowCheckpoint = {
  checkpointId: string
  shadowPath: string
  refPrefix: string
  reflogPath: string
  refs: readonly DevboxGitShadowRef[]
  detachedRefs: readonly string[]
  detachedObjectIds: readonly string[]
  manifestDigest: string
}
export type DevboxGitShadowPeerRequest = {
  checkpoint: DevboxGitShadowCheckpoint
  sourceShadowPath: string
  receiverShadowPath: string
}
export type DevboxGitShadowPeerReceipt = {
  status: 'replicated' | 'unreplicated' | 'failed'
  receivedRefs?: readonly DevboxGitShadowRef[]
  receivedObjectIds?: readonly string[]
  receivedManifestDigest?: string
  receiverCheckpointPath?: string
  error?: DevboxAuthorityError
}
export type DevboxGitShadowPeer = {
  isReachable(): Promise<boolean>
  replicate(request: DevboxGitShadowPeerRequest): Promise<DevboxGitShadowPeerReceipt>
}
export type DevboxGitShadowReplication = {
  status: 'REPLICATED' | 'UNREPLICATED' | 'FAILED'
  receiverCheckpointPath?: string
  attempts: number
}
export type DevboxGitShadowSuccess = {
  status: 'checkpointed'
  checkpoint: DevboxGitShadowCheckpoint
  replication: DevboxGitShadowReplication
}
export type DevboxGitShadowFailure = {
  status: 'blocked' | 'failed'
  error: DevboxAuthorityError
  safeError: DevboxError
  path: string
  stateType: string
  remediation: string
  checkpoint: DevboxGitShadowCheckpoint | null
  receiverCheckpointPath?: string
  replication?: DevboxGitShadowReplication
}
export type DevboxGitShadowResult = DevboxGitShadowSuccess | DevboxGitShadowFailure
export type DevboxGitShadowDependencies = {
  git: DevboxGitShadowRunner
  files: DevboxGitShadowFiles
  peer?: DevboxGitShadowPeer
  maxTransientRetries?: number
}

export const CHECKPOINT_PREFIX = 'refs/devbox/checkpoints/'
export const RECOVERY_PREFIX = 'refs/devbox/recovery/'
const hex = /^[0-9a-f]{40,64}$/i

export function shadowFailure(
  status: 'blocked' | 'failed',
  path: string,
  stateType: string,
  remediation: string,
  code: DevboxAuthorityError['code'],
  checkpoint: DevboxGitShadowCheckpoint | null,
  retryable = false,
  receiverCheckpointPath?: string
): DevboxGitShadowFailure {
  return {
    status,
    error: createDevboxAuthorityError(
      code,
      `${stateType} requires explicit recovery.`,
      retryable,
      path
    ),
    safeError: createDevboxError('unknown', { retryable, context: { field: path } }),
    path,
    stateType,
    remediation,
    checkpoint,
    ...(receiverCheckpointPath ? { receiverCheckpointPath } : {})
  }
}

export function validateShadowInput(input: DevboxGitShadowInput): string | null {
  if (!input.profileId || !input.repositoryId || !input.operationId) {
    return 'profile/repository/operation identity'
  }
  if (!input.sourcePath || !input.shadowPath || !input.reflogPath) {
    return 'source/shadow/reflog path'
  }
  if (!isDevboxAuthorityEpochRecord(input.authority)) {
    return 'authority epoch record'
  }
  for (const ref of input.refs) {
    if (!ref.name.startsWith('refs/') || ref.name.includes('..') || !hex.test(ref.objectId)) {
      return `ref ${ref.name}`
    }
  }
  for (const objectId of input.detachedObjectIds ?? []) {
    if (!hex.test(objectId)) {
      return `detached object ${objectId}`
    }
  }
  return null
}

export const shadowCheckpointId = (input: DevboxGitShadowInput): string =>
  `${input.profileId}-${input.repositoryId}-${input.operationId}`.replace(/[^A-Za-z0-9._-]/g, '-')
export const shadowRecoveryRef = (checkpointId: string, objectId: string): string =>
  `${RECOVERY_PREFIX}${checkpointId}/${objectId.slice(0, 16)}`
export const shadowCheckpointRef = (checkpointId: string, name: string): string =>
  `${CHECKPOINT_PREFIX}${checkpointId}/${name.slice('refs/'.length)}`

export function shadowDigest(
  checkpointId: string,
  refs: readonly DevboxGitShadowRef[],
  detachedRefs: readonly string[],
  reflogRecovery: readonly string[]
): string {
  const value = JSON.stringify({
    checkpointId,
    refs: [...refs].sort((a, b) => a.name.localeCompare(b.name)),
    detachedRefs: [...detachedRefs].sort(),
    reflogRecovery
  })
  return createHash('sha256').update(value).digest('hex')
}

export function parseShadowRefs(stdout: string | undefined): DevboxGitShadowRef[] {
  return (stdout ?? '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && hex.test(parts[1]!))
    .map((parts) => ({ name: parts[0]!, objectId: parts[1]! }))
}

export async function runShadowGit(
  git: DevboxGitShadowRunner,
  command: DevboxGitShadowCommand,
  path: string
): Promise<DevboxGitShadowCommandResult | DevboxGitShadowFailure> {
  const result = await git.run(command)
  return result.exitCode === 0
    ? result
    : shadowFailure(
        'failed',
        path,
        'git-command-failed',
        'Keep both checkpoints and inspect the injected Git failure before retrying.',
        'journal_unavailable',
        null,
        true
      )
}

export async function retryShadowPeer(
  peer: DevboxGitShadowPeer,
  request: DevboxGitShadowPeerRequest,
  retries: number
): Promise<{ receipt: DevboxGitShadowPeerReceipt; attempts: number }> {
  let attempts = 0
  let receipt: DevboxGitShadowPeerReceipt = { status: 'failed' }
  while (attempts <= retries) {
    attempts += 1
    receipt = await peer.replicate(request)
    if (receipt.status !== 'failed' || attempts > retries) {
      return { receipt, attempts }
    }
  }
  return { receipt, attempts }
}

export function verifyShadowPeer(
  checkpoint: DevboxGitShadowCheckpoint,
  receipt: DevboxGitShadowPeerReceipt
): string | null {
  const received = new Map((receipt.receivedRefs ?? []).map((ref) => [ref.name, ref.objectId]))
  for (const ref of checkpoint.refs) {
    const expected = shadowCheckpointRef(checkpoint.checkpointId, ref.name)
    if (received.get(expected) !== ref.objectId) {
      return expected
    }
  }
  for (const objectId of checkpoint.detachedObjectIds) {
    if (!(receipt.receivedObjectIds ?? []).includes(objectId)) {
      return objectId
    }
  }
  if (receipt.receivedManifestDigest !== checkpoint.manifestDigest) {
    return checkpoint.reflogPath
  }
  return null
}
