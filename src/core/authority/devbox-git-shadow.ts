import type {
  DevboxGitShadowCheckpoint,
  DevboxGitShadowDependencies,
  DevboxGitShadowInput,
  DevboxGitShadowPeerReceipt,
  DevboxGitShadowResult
} from './devbox-git-shadow-types'
import {
  shadowCheckpointId,
  shadowCheckpointRef,
  shadowDigest,
  shadowFailure,
  shadowRecoveryRef,
  validateShadowInput,
  verifyShadowPeer,
  retryShadowPeer,
  runShadowGit
} from './devbox-git-shadow-types'

export type {
  DevboxGitShadowCheckpoint,
  DevboxGitShadowCommand,
  DevboxGitShadowCommandResult,
  DevboxGitShadowDependencies,
  DevboxGitShadowFiles,
  DevboxGitShadowInput,
  DevboxGitShadowPeer,
  DevboxGitShadowPeerReceipt,
  DevboxGitShadowPeerRequest,
  DevboxGitShadowRef,
  DevboxGitShadowReplication,
  DevboxGitShadowResult,
  DevboxGitShadowRunner,
  DevboxGitShadowSuccess,
  DevboxGitShadowFailure
} from './devbox-git-shadow-types'

export class DevboxGitShadow {
  constructor(private readonly dependencies: DevboxGitShadowDependencies) {}

  async checkpoint(input: DevboxGitShadowInput): Promise<DevboxGitShadowResult> {
    const invalid = validateShadowInput(input)
    if (invalid) {
      return shadowFailure(
        'blocked',
        invalid,
        'invalid-shadow-input',
        'Correct the named identity, path, epoch, ref, or object before checkpointing.',
        'transition_blocked',
        null
      )
    }
    const checkpointId = shadowCheckpointId(input)
    const detachedRefs = (input.detachedObjectIds ?? []).map((objectId) =>
      shadowRecoveryRef(checkpointId, objectId)
    )
    const checkpoint: DevboxGitShadowCheckpoint = {
      checkpointId,
      shadowPath: input.shadowPath,
      refPrefix: `refs/devbox/checkpoints/${checkpointId}/`,
      reflogPath: input.reflogPath,
      refs: input.refs,
      detachedRefs,
      detachedObjectIds: input.detachedObjectIds ?? [],
      manifestDigest: shadowDigest(
        checkpointId,
        input.refs,
        detachedRefs,
        input.reflogRecovery ?? []
      )
    }
    const init = await runShadowGit(
      this.dependencies.git,
      { cwd: input.shadowPath, args: ['init', '--bare', '--quiet', input.shadowPath] },
      input.shadowPath
    )
    if ('status' in init) {
      return { ...init, checkpoint }
    }
    for (const [index, objectId] of (input.detachedObjectIds ?? []).entries()) {
      const result = await runShadowGit(
        this.dependencies.git,
        {
          cwd: input.sourcePath,
          args: ['update-ref', detachedRefs[index]!, objectId]
        },
        `${input.sourcePath}/${detachedRefs[index]!}`
      )
      if ('status' in result) {
        return { ...result, checkpoint }
      }
    }
    const fetch = await runShadowGit(
      this.dependencies.git,
      {
        cwd: input.shadowPath,
        args: ['fetch', '--no-tags', input.sourcePath, `refs/*:${checkpoint.refPrefix}*`]
      },
      input.shadowPath
    )
    if ('status' in fetch) {
      return { ...fetch, checkpoint }
    }
    const verified = await runShadowGit(
      this.dependencies.git,
      {
        cwd: input.shadowPath,
        args: ['for-each-ref', '--format=%(refname) %(objectname)', checkpoint.refPrefix]
      },
      `${input.shadowPath}/${checkpoint.refPrefix}`
    )
    if ('status' in verified) {
      return { ...verified, checkpoint }
    }
    const actual = new Map(
      (verified.stdout ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map((parts) => [parts[0]!, parts[1]!])
    )
    const missing = input.refs.find(
      (ref) => actual.get(shadowCheckpointRef(checkpointId, ref.name)) !== ref.objectId
    )
    const missingDetached = (input.detachedObjectIds ?? []).find(
      (objectId, index) =>
        actual.get(shadowCheckpointRef(checkpointId, detachedRefs[index]!)) !== objectId
    )
    if (missing || missingDetached) {
      return shadowFailure(
        'failed',
        missing?.name ?? missingDetached!,
        'shadow-verification-mismatch',
        'Retain the local shadow and source; inspect object reachability before retrying.',
        'external_drift',
        checkpoint
      )
    }
    try {
      await this.dependencies.files.write(
        input.reflogPath,
        JSON.stringify({
          checkpointId,
          refs: input.refs,
          detachedRefs,
          detachedObjectIds: input.detachedObjectIds ?? [],
          reflogRecovery: input.reflogRecovery ?? [],
          manifestDigest: checkpoint.manifestDigest
        })
      )
    } catch {
      return shadowFailure(
        'failed',
        input.reflogPath,
        'reflog-recovery-write-failed',
        'Retain the Git shadow and restore the reflog recovery manifest before retrying.',
        'journal_unavailable',
        checkpoint,
        true
      )
    }
    return this.replicate(checkpoint, input)
  }

  private async replicate(
    checkpoint: DevboxGitShadowCheckpoint,
    input: DevboxGitShadowInput
  ): Promise<DevboxGitShadowResult> {
    if (!this.dependencies.peer) {
      return {
        status: 'checkpointed',
        checkpoint,
        replication: { status: 'UNREPLICATED', attempts: 0 }
      }
    }
    let reachable = false
    try {
      reachable = await this.dependencies.peer.isReachable()
    } catch {
      reachable = false
    }
    if (!reachable) {
      return {
        status: 'checkpointed',
        checkpoint,
        replication: { status: 'UNREPLICATED', attempts: 0 }
      }
    }
    let receipt: DevboxGitShadowPeerReceipt = { status: 'failed' }
    let attempts = 0
    try {
      const retry = await retryShadowPeer(
        this.dependencies.peer,
        {
          checkpoint,
          sourceShadowPath: input.shadowPath,
          receiverShadowPath: `${input.shadowPath}.peer`
        },
        Math.min(this.dependencies.maxTransientRetries ?? 2, 2)
      )
      receipt = retry.receipt
      attempts = retry.attempts
    } catch {
      return shadowFailure(
        'failed',
        input.shadowPath,
        'peer-replication-failed',
        'Retain both authority and receiver checkpoints; retry only after peer transport recovery.',
        'journal_unavailable',
        checkpoint,
        true
      )
    }
    if (receipt.status === 'unreplicated') {
      return {
        status: 'checkpointed',
        checkpoint,
        replication: { status: 'UNREPLICATED', attempts }
      }
    }
    if (receipt.status !== 'replicated') {
      return {
        ...shadowFailure(
          'failed',
          input.shadowPath,
          'peer-replication-failed',
          'Retain both authority and receiver checkpoints; retry only after peer transport recovery.',
          receipt.error?.code ?? 'journal_unavailable',
          checkpoint,
          true,
          receipt.receiverCheckpointPath
        ),
        replication: { status: 'FAILED', attempts }
      }
    }
    const mismatch = verifyShadowPeer(checkpoint, receipt)
    if (mismatch) {
      return {
        ...shadowFailure(
          'failed',
          mismatch,
          'peer-verification-mismatch',
          'Retain both checkpoints and compare the receiver manifest before any retry.',
          'external_drift',
          checkpoint,
          false,
          receipt.receiverCheckpointPath
        ),
        replication: { status: 'FAILED', attempts }
      }
    }
    return {
      status: 'checkpointed',
      checkpoint,
      replication: {
        status: 'REPLICATED',
        attempts,
        ...(receipt.receiverCheckpointPath
          ? { receiverCheckpointPath: receipt.receiverCheckpointPath }
          : {})
      }
    }
  }
}

export async function checkpointDevboxGitShadow(
  dependencies: DevboxGitShadowDependencies,
  input: DevboxGitShadowInput
): Promise<DevboxGitShadowResult> {
  return new DevboxGitShadow(dependencies).checkpoint(input)
}
