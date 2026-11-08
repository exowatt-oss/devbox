import {
  checkConfigDivergence,
  checkRefDivergence,
  configMap,
  reconcileBlock,
  reconcileIndexInput,
  reconcileMappedPath,
  reconcileProof,
  refMap,
  runReconcileGit,
  sortedRefs,
  validateReconcileInput,
  type DevboxGitCheckpointPair,
  type DevboxGitReconcileFailure,
  type DevboxGitReconcileInput,
  type DevboxGitReconcileResult,
  type DevboxGitReconcilerCommand,
  type DevboxGitWorktree,
  type DevboxGitReconcilerDependencies
} from './devbox-git-reconciler-types'
export type * from './devbox-git-reconciler-types'
function topologyBlock(
  input: DevboxGitReconcileInput,
  checkpoints: DevboxGitCheckpointPair | null
): ReturnType<typeof reconcileBlock> | null {
  const state = input.objectState
  const checks = [
    [
      state.reachable && (state.missingObjectIds?.length ?? 0) === 0,
      'failed',
      `${input.sourcePath}/objects`,
      'unreachable-git-objects',
      'Restore the named objects from a verified source and retain both checkpoints.'
    ],
    [
      state.lfsSelfContained,
      'blocked',
      `${input.sourcePath}/.git/lfs/objects`,
      'missing-lfs-objects',
      'Fetch and verify LFS objects on the authority host before handoff.'
    ],
    [
      state.promisedObjectsSelfContained && state.shallowState !== 'unsupported',
      'blocked',
      `${input.sourcePath}/.git/shallow`,
      'missing-promised-objects',
      'Materialize shallow/promised objects or keep authority on the source host.'
    ],
    [
      state.alternatesSelfContained,
      'blocked',
      state.alternatePaths?.[0] ?? `${input.sourcePath}/.git/objects/info/alternates`,
      'host-specific-alternate',
      'Copy objects through Git into a self-contained shadow or declare a verified host mapping.'
    ]
  ] as const
  const failed = checks.find((check) => !check[0])
  return failed
    ? reconcileBlock(failed[1], failed[2], failed[3], failed[4], 'transition_blocked', checkpoints)
    : null
}
export class DevboxGitReconciler {
  constructor(private readonly dependencies: DevboxGitReconcilerDependencies) {}
  async reconcile(input: DevboxGitReconcileInput): Promise<DevboxGitReconcileResult> {
    let checkpoints = input.checkpoints ?? null
    if (this.dependencies.checkpoints) {
      try {
        checkpoints = await this.dependencies.checkpoints.checkpoint({
          repositoryId: input.repositoryId,
          sourcePath: input.sourcePath,
          receiverPath: input.receiverPath,
          phase: 'before'
        })
      } catch {
        return reconcileBlock(
          'failed',
          input.repositoryId,
          'checkpoint-failed',
          'Retain the existing source and receiver checkpoints and repair checkpoint storage.',
          'journal_unavailable',
          checkpoints,
          true
        )
      }
    }
    const invalid = validateReconcileInput(input)
    if (invalid) {
      return reconcileBlock(
        invalid === 'authority' ? 'failed' : 'blocked',
        invalid.replace('unresolved-index:', ''),
        invalid === 'authority'
          ? 'ambiguous-authority'
          : invalid.startsWith('unresolved-index:')
            ? 'unresolved-index-conflict'
            : 'invalid-reconciler-input',
        'Correct the named inventory or authority evidence before retrying.',
        invalid === 'authority' ? 'split_authority' : 'transition_blocked',
        checkpoints
      )
    }
    if (input.operationState) {
      return reconcileBlock(
        'blocked',
        input.operationState.path,
        `${input.operationState.kind}-in-progress`,
        'Finish or explicitly recover the in-progress Git operation before handoff.',
        'transition_blocked',
        checkpoints
      )
    }
    const topology = topologyBlock(input, checkpoints)
    if (topology) {
      return topology
    }
    const refs = checkRefDivergence(input, checkpoints)
    if (refs) {
      return refs
    }
    const config = checkConfigDivergence(input, checkpoints)
    if (config) {
      return config
    }
    const worktrees: DevboxGitWorktree[] = []
    const mappedUntrackedPaths: string[] = []
    for (const worktree of input.sourceWorktrees ?? []) {
      const destination = reconcileMappedPath(input, worktree.path, checkpoints)
      if (typeof destination !== 'string') {
        return destination
      }
      worktrees.push({ ...worktree, path: destination })
    }
    for (const path of input.untrackedPaths ?? []) {
      const destination = reconcileMappedPath(input, path, checkpoints)
      if (typeof destination !== 'string') {
        return destination
      }
      mappedUntrackedPaths.push(destination)
    }
    const apply = async (command: DevboxGitReconcilerCommand): Promise<void> => {
      const failure = await runReconcileGit(this.dependencies, command, checkpoints)
      if (failure) {
        throw failure
      }
    }
    try {
      await apply({ cwd: input.receiverPath, args: ['init', input.receiverPath] })
      if ((input.sourceConfig ?? []).some(({ key }) => key.startsWith('filter.lfs'))) {
        await apply({
          cwd: input.receiverPath,
          args: ['lfs', 'fetch', '--all', input.transferPath]
        })
      }
      const receiverRefs = refMap(input.receiverRefs)
      for (const ref of input.sourceRefs) {
        if (!receiverRefs.has(ref.name)) {
          await apply({
            cwd: input.receiverPath,
            args: ['fetch', '--no-tags', input.transferPath, `${ref.name}:${ref.name}`]
          })
        }
      }
      const receiverConfig = configMap(input.receiverConfig ?? [])
      for (const entry of input.sourceConfig ?? []) {
        if (!receiverConfig.has(entry.key)) {
          await apply({
            cwd: input.receiverPath,
            args: ['config', '--local', entry.key, entry.value]
          })
        }
      }
      if (input.sourceHead && !input.receiverHead) {
        await apply({
          cwd: input.receiverPath,
          args: ['symbolic-ref', 'HEAD', input.sourceHead]
        })
      }
      for (const worktree of worktrees) {
        await apply({
          cwd: input.receiverPath,
          args: ['worktree', 'add', '--detach', worktree.path, worktree.head]
        })
      }
      if ((input.index?.length ?? 0) > 0) {
        await apply({
          cwd: input.receiverPath,
          args: ['update-index', '--index-info'],
          stdin: `${reconcileIndexInput(input.index ?? [])}\n`
        })
        for (const entry of input.index ?? []) {
          for (const [flag, enabled] of [
            ['--assume-unchanged', entry.assumeUnchanged],
            ['--skip-worktree', entry.skipWorktree]
          ] as const) {
            if (enabled) {
              await apply({
                cwd: input.receiverPath,
                args: ['update-index', flag, '--', entry.path]
              })
            }
          }
        }
      }
      if ((input.objectState.alternatePaths?.length ?? 0) > 0) {
        await apply({
          cwd: input.receiverPath,
          args: ['config', '--local', 'remote.origin.promisor', 'true']
        })
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error) {
        return error as DevboxGitReconcileFailure
      }
      return reconcileBlock(
        'failed',
        input.receiverPath,
        'git-command-failed',
        'Retain both checkpoints and inspect the typed Git phase failure before retrying.',
        'journal_unavailable',
        checkpoints,
        true
      )
    }
    const recoveryFiles: string[] = []
    let hookActivation: 'active' | 'preserved-inactive' = 'active'
    for (const file of input.recoveryFiles ?? []) {
      const recoveryPath = `${input.receiverPath}/.devbox-recovery/${input.repositoryId}/${file.path}`
      try {
        await this.dependencies.files.write(recoveryPath, file.contents, file.mode)
        recoveryFiles.push(recoveryPath)
        if (file.kind === 'hook' && file.executable && input.projectTrust !== 'approved') {
          hookActivation = 'preserved-inactive'
          continue
        }
        await this.dependencies.files.write(
          `${input.receiverPath}/${file.path}`,
          file.contents,
          file.mode
        )
      } catch {
        return reconcileBlock(
          'failed',
          recoveryPath,
          'recovery-file-write-failed',
          'Retain both checkpoints and restore the recovery file through the injected filesystem.',
          'journal_unavailable',
          checkpoints,
          true
        )
      }
    }
    if (input.receiverAfterRefs) {
      const drift = checkRefDivergence(input, checkpoints)
      if (drift) {
        return drift
      }
    }
    if (this.dependencies.checkpoints) {
      try {
        checkpoints = await this.dependencies.checkpoints.checkpoint({
          repositoryId: input.repositoryId,
          sourcePath: input.sourcePath,
          receiverPath: input.receiverPath,
          phase: 'after'
        })
      } catch {
        return reconcileBlock(
          'failed',
          input.repositoryId,
          'checkpoint-failed',
          'Freeze the reconciled receiver and retain the prior source checkpoint before retrying.',
          'journal_unavailable',
          checkpoints,
          true
        )
      }
    }
    return {
      status: 'reconciled',
      checkpoints: checkpoints ?? { source: input.sourcePath, receiver: input.receiverPath },
      proof: reconcileProof(input, worktrees, mappedUntrackedPaths),
      receiverOnlyRefs: sortedRefs(
        input.receiverRefs.filter(
          (ref) => !input.sourceRefs.some((source) => source.name === ref.name)
        )
      ),
      hookActivation,
      recoveryFiles
    }
  }
}
export async function reconcileDevboxGit(
  dependencies: DevboxGitReconcilerDependencies,
  input: DevboxGitReconcileInput
): Promise<DevboxGitReconcileResult> {
  return new DevboxGitReconciler(dependencies).reconcile(input)
}
