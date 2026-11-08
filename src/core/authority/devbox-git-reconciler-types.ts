import { createDevboxError, type DevboxError } from '../../shared/devbox-errors'
import {
  isDevboxAuthorityEpochRecord,
  type DevboxAuthorityEpochRecord
} from '../../shared/devbox-types'
import type { DevboxPathMapper } from '../devbox-path-mapper'
import { createDevboxAuthorityError, type DevboxAuthorityError } from './devbox-authority-witness'

export type DevboxGitReconcilerCommand = { cwd: string; args: readonly string[]; stdin?: string }
export type DevboxGitReconcilerCommandResult = { exitCode: number; stdout?: string }
export type DevboxGitReconcilerGit = {
  run(command: DevboxGitReconcilerCommand): Promise<DevboxGitReconcilerCommandResult>
}
export type DevboxGitReconcilerFiles = {
  write(path: string, contents: string | Uint8Array, mode: number): Promise<void>
}
export type DevboxGitRef = { name: string; objectId: string }
export type DevboxGitConfigEntry = { key: string; value: string }
export type DevboxGitIndexEntry = {
  path: string
  mode: string
  objectId: string
  stage?: number
  assumeUnchanged?: boolean
  skipWorktree?: boolean
}
export type DevboxGitWorktree = { id: string; path: string; head: string; branch?: string }
export type DevboxGitRecoveryFile = {
  path: string
  contents: string | Uint8Array
  mode: number
  executable: boolean
  kind: 'hook' | 'template' | 'rerere'
}
export type DevboxGitObjectState = {
  reachable: boolean
  missingObjectIds?: readonly string[]
  lfsSelfContained: boolean
  promisedObjectsSelfContained: boolean
  shallowState?: 'self-contained' | 'unsupported'
  alternatesSelfContained: boolean
  alternatePaths?: readonly string[]
}
export type DevboxGitProof = {
  refs: readonly DevboxGitRef[]
  config: readonly DevboxGitConfigEntry[]
  worktrees: readonly DevboxGitWorktree[]
  index: readonly DevboxGitIndexEntry[]
  untrackedPaths: readonly string[]
}
export type DevboxGitCheckpointPair = { source: string; receiver: string }
export type DevboxGitCheckpointProvider = {
  checkpoint(input: {
    repositoryId: string
    sourcePath: string
    receiverPath: string
    phase: 'before' | 'after'
  }): Promise<DevboxGitCheckpointPair>
}
export type DevboxGitReconcileInput = {
  profileId: string
  repositoryId: string
  operationId: string
  sourcePath: string
  receiverPath: string
  transferPath: string
  authority: 'verified' | 'ambiguous'
  authorityEpoch: DevboxAuthorityEpochRecord
  pathMapper: DevboxPathMapper
  sourceRefs: readonly DevboxGitRef[]
  receiverRefs: readonly DevboxGitRef[]
  receiverAfterRefs?: readonly DevboxGitRef[]
  sourceHead?: string
  receiverHead?: string
  sourceConfig?: readonly DevboxGitConfigEntry[]
  receiverConfig?: readonly DevboxGitConfigEntry[]
  sourceWorktrees?: readonly DevboxGitWorktree[]
  receiverWorktrees?: readonly DevboxGitWorktree[]
  index?: readonly DevboxGitIndexEntry[]
  untrackedPaths?: readonly string[]
  recoveryFiles?: readonly DevboxGitRecoveryFile[]
  objectState: DevboxGitObjectState
  operationState?: { kind: string; path: string }
  projectTrust?: 'approved' | 'not-approved'
  checkpoints?: DevboxGitCheckpointPair
}
export type DevboxGitReconcilerDependencies = {
  git: DevboxGitReconcilerGit
  files: DevboxGitReconcilerFiles
  checkpoints?: DevboxGitCheckpointProvider
}
export type DevboxGitReconcileSuccess = {
  status: 'reconciled'
  checkpoints: DevboxGitCheckpointPair
  proof: DevboxGitProof
  receiverOnlyRefs: readonly DevboxGitRef[]
  hookActivation: 'active' | 'preserved-inactive'
  recoveryFiles: readonly string[]
}
export type DevboxGitReconcileFailure = {
  status: 'blocked' | 'failed'
  error: DevboxAuthorityError
  safeError: DevboxError
  path: string
  stateType: string
  remediation: string
  checkpoints: DevboxGitCheckpointPair | null
}
export type DevboxGitReconcileResult = DevboxGitReconcileSuccess | DevboxGitReconcileFailure
const hex = /^[0-9a-f]{40,64}$/i
const forbidden = new Set(['reset', 'clean', 'prune', 'gc', 'delete-ref', '--force', '-f'])
export function reconcileBlock(
  status: 'blocked' | 'failed',
  path: string,
  stateType: string,
  remediation: string,
  code: DevboxAuthorityError['code'],
  checkpoints: DevboxGitCheckpointPair | null,
  retryable = false
): DevboxGitReconcileFailure {
  return {
    status,
    error: createDevboxAuthorityError(
      code,
      `${stateType} requires explicit recovery.`,
      retryable,
      path
    ),
    safeError: createDevboxError('operation_conflict', {
      retryable,
      context: { field: path }
    }),
    path,
    stateType,
    remediation,
    checkpoints
  }
}
export const sortedRefs = (refs: readonly DevboxGitRef[]): DevboxGitRef[] =>
  [...refs].sort((a, b) => a.name.localeCompare(b.name) || a.objectId.localeCompare(b.objectId))
export const refMap = (refs: readonly DevboxGitRef[]): Map<string, string> =>
  new Map(refs.map((ref) => [ref.name, ref.objectId]))
export const configMap = (entries: readonly DevboxGitConfigEntry[]): Map<string, string> =>
  new Map(entries.map((entry) => [entry.key, entry.value]))
function validateRefs(refs: readonly DevboxGitRef[]): string | null {
  for (const ref of refs) {
    if (!ref.name.startsWith('refs/') || ref.name.includes('..') || !hex.test(ref.objectId)) {
      return ref.name
    }
  }
  return null
}
export function validateReconcileInput(input: DevboxGitReconcileInput): string | null {
  if (!input.profileId || !input.repositoryId || !input.operationId) {
    return 'repository identity'
  }
  if (!input.sourcePath || !input.receiverPath || !input.transferPath) {
    return 'repository transfer path'
  }
  if (input.authority !== 'verified') {
    return 'authority'
  }
  if (!isDevboxAuthorityEpochRecord(input.authorityEpoch)) {
    return 'authority epoch'
  }
  return (
    validateRefs(input.sourceRefs) ??
    validateRefs(input.receiverRefs) ??
    input.index
      ?.find((entry) => (entry.stage ?? 0) !== 0)
      ?.path?.replace(/^/, 'unresolved-index:') ??
    null
  )
}
export function reconcileMappedPath(
  input: DevboxGitReconcileInput,
  path: string,
  checkpoints: DevboxGitCheckpointPair | null
): string | DevboxGitReconcileFailure {
  const result = input.pathMapper.map(path)
  if (result.status !== 'mapped') {
    return reconcileBlock(
      'blocked',
      path,
      'path-mapping',
      'Declare the path in the Devbox path map or preserve the worktree on its current host.',
      result.error.code === 'operation_conflict' ? 'external_drift' : 'transition_blocked',
      checkpoints
    )
  }
  return result.mappedPath
}
export function checkRefDivergence(
  input: DevboxGitReconcileInput,
  checkpoints: DevboxGitCheckpointPair | null
): DevboxGitReconcileFailure | null {
  const source = refMap(input.sourceRefs)
  const receiver = refMap(input.receiverRefs)
  for (const [name, objectId] of source) {
    const current = receiver.get(name)
    if (current !== undefined && current !== objectId) {
      return reconcileBlock(
        'blocked',
        `${input.receiverPath}/${name}`,
        'receiver-ref-divergence',
        'Preserve the receiver ref, create an explicit merge or namespaced import, then retry.',
        'external_drift',
        checkpoints
      )
    }
  }
  if (input.receiverAfterRefs) {
    const after = refMap(input.receiverAfterRefs)
    for (const [name, objectId] of receiver) {
      if (after.get(name) !== objectId) {
        return reconcileBlock(
          'failed',
          `${input.receiverPath}/${name}`,
          'receiver-only-ref-changed',
          'Freeze both checkpoints and reconcile the receiver-only ref before retrying.',
          'external_drift',
          checkpoints
        )
      }
    }
  }
  return null
}
export function checkConfigDivergence(
  input: DevboxGitReconcileInput,
  checkpoints: DevboxGitCheckpointPair | null
): DevboxGitReconcileFailure | null {
  const source = configMap(input.sourceConfig ?? [])
  const receiver = configMap(input.receiverConfig ?? [])
  for (const [key, value] of source) {
    if (receiver.get(key) !== undefined && receiver.get(key) !== value) {
      return reconcileBlock(
        'blocked',
        `${input.receiverPath}/config:${key}`,
        'receiver-config-divergence',
        'Preserve the receiver value and choose an explicit config merge before retrying.',
        'external_drift',
        checkpoints
      )
    }
  }
  return null
}

export function reconcileCommandSafe(command: DevboxGitReconcilerCommand): boolean {
  return !command.args.some((arg) => forbidden.has(arg) || arg.startsWith('--force='))
}

export async function runReconcileGit(
  dependencies: DevboxGitReconcilerDependencies,
  command: DevboxGitReconcilerCommand,
  checkpoints: DevboxGitCheckpointPair | null
): Promise<DevboxGitReconcileFailure | null> {
  if (!reconcileCommandSafe(command)) {
    return reconcileBlock(
      'blocked',
      command.cwd,
      'forbidden-git-command',
      'Use an additive Git transfer or preserve the receiver state; destructive commands are forbidden.',
      'transition_blocked',
      checkpoints
    )
  }
  const result = await dependencies.git.run(command)
  return result.exitCode === 0
    ? null
    : reconcileBlock(
        'failed',
        command.cwd,
        'git-command-failed',
        'Retain both checkpoints and inspect the typed Git phase failure before retrying.',
        'journal_unavailable',
        checkpoints,
        true
      )
}

export function reconcileIndexInput(entries: readonly DevboxGitIndexEntry[]): string {
  return entries
    .map((entry) => `${entry.mode} ${entry.objectId} ${entry.stage ?? 0}\t${entry.path}`)
    .join('\n')
}
export function reconcileProof(
  input: DevboxGitReconcileInput,
  worktrees: DevboxGitWorktree[],
  untrackedPaths = input.untrackedPaths ?? []
): DevboxGitProof {
  return {
    refs: sortedRefs(input.sourceRefs),
    config: [...(input.sourceConfig ?? [])].sort((a, b) => a.key.localeCompare(b.key)),
    worktrees: worktrees.sort((a, b) => a.path.localeCompare(b.path)),
    index: [...(input.index ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    untrackedPaths: [...untrackedPaths].sort()
  }
}
