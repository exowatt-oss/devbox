import type { DevboxOperationPhase } from '../../shared/devbox-types'
import type { DevboxAuthorityError } from './devbox-authority-witness'
import {
  epochError,
  mappedTargetPath,
  policyError,
  processBlocker,
  processEvidence,
  readStableJsonl,
  sessionOperation,
  stabilityError,
  type DevboxPreparedSession,
  type DevboxSessionArchiveResult,
  type DevboxSessionOpenResult,
  type DevboxSessionPolicyBlocked,
  type DevboxSessionPolicyOptions,
  type DevboxSessionPolicyRequest,
  type DevboxSessionProcessInventory
} from './devbox-session-policy-support'

export type * from './devbox-session-policy-support'

type SessionResult = DevboxSessionArchiveResult | DevboxSessionOpenResult
type SessionAction<T extends SessionResult> = Readonly<{
  skip: (prepared: DevboxPreparedSession) => { safe: boolean; result: T } | undefined
  write: (input: { path: string; content: string; sourcePath: string }) => Promise<void>
  complete: (input: {
    prepared: DevboxPreparedSession
    path: string
    inventory: DevboxSessionProcessInventory
  }) => T
}>

export class DevboxSessionPolicy {
  constructor(private readonly options: DevboxSessionPolicyOptions) {}

  archiveChanged(request: DevboxSessionPolicyRequest): Promise<DevboxSessionArchiveResult> {
    return this.run<DevboxSessionArchiveResult>(request, {
      skip: (prepared) =>
        prepared.discovery.changed
          ? undefined
          : {
              safe: true,
              result: {
                status: 'unchanged',
                sessionPath: request.sessionPath,
                inventory: prepared.inventory
              }
            },
      write: ({ path, content, sourcePath }) =>
        this.options.filesystem.archive({ sourcePath, archivePath: path, content }),
      complete: ({ prepared, path, inventory }) => ({
        status: 'archived',
        sessionPath: prepared.request.sessionPath,
        archivePath: path,
        inventory
      })
    })
  }

  open(request: DevboxSessionPolicyRequest): Promise<DevboxSessionOpenResult> {
    return this.run<DevboxSessionOpenResult>(request, {
      skip: (prepared) =>
        request.targetOwner === request.authorityEpoch.owner
          ? {
              safe: true,
              result: {
                status: 'attached',
                sessionPath: request.sessionPath,
                inventory: prepared.inventory
              }
            }
          : undefined,
      write: ({ path, content, sourcePath }) =>
        this.options.filesystem.fork({ sourcePath, forkPath: path, content }),
      complete: ({ prepared, path, inventory }) => ({
        status: 'forked',
        sessionPath: prepared.request.sessionPath,
        forkPath: path,
        inventory
      })
    })
  }

  private async run<T extends SessionResult>(
    request: DevboxSessionPolicyRequest,
    action: SessionAction<T>
  ): Promise<T | DevboxSessionPolicyBlocked> {
    const prepared = await this.prepare(request)
    if ('error' in prepared) {
      return prepared
    }
    const early = action.skip(prepared)
    if (early?.safe) {
      return this.finish(prepared, early.result)
    }
    const initialBlock = processBlocker(request.sessionPath, prepared.inventory)
    if (initialBlock) {
      return this.block(prepared, initialBlock)
    }
    if (early) {
      return this.finish(prepared, early.result)
    }
    const path = mappedTargetPath(this.options, request)
    if (typeof path !== 'string') {
      return this.block(prepared, path)
    }
    const checkpointError = this.journalPhaseAt(
      prepared.request,
      'checkpointing',
      prepared.startedAt
    )
    if (checkpointError) {
      return this.block(prepared, checkpointError)
    }
    const stable = await readStableJsonl({
      path: request.sessionPath,
      filesystem: this.options.filesystem,
      clock: this.options.clock,
      startedAt: this.options.clock.now(),
      observation: this.options.observation
    })
    if (stable.status !== 'stable') {
      return this.block(prepared, stabilityError(request.sessionPath, stable))
    }
    const reconciled = await this.inspectAgain(prepared)
    if ('error' in reconciled) {
      return reconciled
    }
    const finalBlock = processBlocker(request.sessionPath, reconciled.inventory)
    if (finalBlock) {
      return this.block(reconciled, finalBlock)
    }
    const commitError = this.journalPhaseAt(
      reconciled.request,
      'committing-epoch',
      reconciled.startedAt
    )
    if (commitError) {
      return this.block(reconciled, commitError)
    }
    try {
      await action.write({ path, content: stable.content, sourcePath: request.sessionPath })
    } catch (error) {
      return this.block(
        reconciled,
        policyError(
          request.sessionPath,
          `The session destination write failed: ${String(error)}.`,
          'Keep the session on its authority and retry after the destination is writable.',
          'transition_blocked',
          processEvidence(reconciled.inventory)
        )
      )
    }
    return this.finish(
      reconciled,
      action.complete({ prepared, path, inventory: reconciled.inventory })
    )
  }

  private async prepare(
    request: DevboxSessionPolicyRequest
  ): Promise<DevboxPreparedSession | DevboxSessionPolicyBlocked> {
    const startedAt = this.options.clock.now()
    const initialError = this.journalPhaseAt(request, 'preparing', startedAt)
    if (initialError) {
      return this.blockWithoutInventory(request, startedAt, initialError)
    }
    const epoch = this.options.authority.validateEpoch(request.authorityEpoch)
    if (epoch.status === 'rejected') {
      return this.blockWithoutInventory(request, startedAt, epochError(request.sessionPath, epoch))
    }
    try {
      const records = await this.options.discovery.discover({
        sessionPath: request.sessionPath,
        authorityOwner: request.authorityEpoch.owner
      })
      const matches = records.filter((record) => record.sessionPath === request.sessionPath)
      if (matches.length !== 1) {
        return this.fail(
          request,
          startedAt,
          `Discovery returned ${matches.length} matching session records.`,
          'Refresh discovery and retry only when exactly one session record is found.'
        )
      }
      const phaseError = this.journalPhaseAt(request, 'quiescing', startedAt)
      if (phaseError) {
        return this.blockWithoutInventory(request, startedAt, phaseError)
      }
      const inventory = await this.options.processes.inspect({
        sessionPath: request.sessionPath,
        authorityEpoch: request.authorityEpoch,
        operationId: request.operationId
      })
      return { request, discovery: matches[0]!, inventory, startedAt }
    } catch (error) {
      return this.fail(
        request,
        startedAt,
        `Session discovery or process inventory failed: ${String(error)}.`,
        'Treat the host as occupied; restore discovery and process inspection, then retry.',
        'unknown'
      )
    }
  }

  private fail(
    request: DevboxSessionPolicyRequest,
    startedAt: number,
    reason: string,
    remediation: string,
    evidence = 'not-inspected'
  ): DevboxSessionPolicyBlocked {
    return this.blockWithoutInventory(
      request,
      startedAt,
      policyError(request.sessionPath, reason, remediation, 'transition_blocked', evidence)
    )
  }

  private async inspectAgain(
    prepared: DevboxPreparedSession
  ): Promise<DevboxPreparedSession | DevboxSessionPolicyBlocked> {
    const phaseError = this.journalPhaseAt(prepared.request, 'reconciling', prepared.startedAt)
    if (phaseError) {
      return this.block(prepared, phaseError)
    }
    try {
      const inventory = await this.options.processes.inspect({
        sessionPath: prepared.request.sessionPath,
        authorityEpoch: prepared.request.authorityEpoch,
        operationId: prepared.request.operationId
      })
      return { ...prepared, inventory }
    } catch (error) {
      return this.block(
        prepared,
        policyError(
          prepared.request.sessionPath,
          `Final process inventory failed: ${String(error)}.`,
          'Keep the session on its authority and retry after inspection is restored.',
          'transition_blocked',
          processEvidence(prepared.inventory)
        )
      )
    }
  }

  private finish<T extends SessionResult>(
    prepared: DevboxPreparedSession,
    result: T
  ): T | DevboxSessionPolicyBlocked {
    for (const phase of ['verifying', 'resuming', 'completed'] as const) {
      const error = this.journalPhaseAt(prepared.request, phase, prepared.startedAt)
      if (error) {
        return this.block(prepared, error)
      }
    }
    return result
  }

  private block(
    prepared: DevboxPreparedSession,
    error: DevboxAuthorityError
  ): DevboxSessionPolicyBlocked {
    return {
      status: 'blocked',
      error: this.journalPhaseAt(prepared.request, 'blocked', prepared.startedAt) ?? error,
      inventory: prepared.inventory
    }
  }

  private blockWithoutInventory(
    request: DevboxSessionPolicyRequest,
    startedAt: number,
    error: DevboxAuthorityError
  ): DevboxSessionPolicyBlocked {
    return { status: 'blocked', error: this.journalPhaseAt(request, 'blocked', startedAt) ?? error }
  }

  private journalPhaseAt(
    request: DevboxSessionPolicyRequest,
    phase: DevboxOperationPhase,
    startedAt: number
  ): DevboxAuthorityError | undefined {
    try {
      const result = this.options.journal.append(
        sessionOperation(request, phase, startedAt, this.options.clock.now()),
        { recordId: `${request.operationId}:${phase}` }
      )
      return result.status === 'written'
        ? undefined
        : policyError(
            request.sessionPath,
            `The operation journal rejected phase ${phase}.`,
            'Restore the Devbox journal and retry without changing session authority.',
            'journal_unavailable',
            'process evidence unavailable while journaling'
          )
    } catch (error) {
      return policyError(
        request.sessionPath,
        `The operation journal failed during phase ${phase}: ${String(error)}.`,
        'Restore the Devbox journal and retry without changing session authority.',
        'journal_unavailable',
        'process evidence unavailable while journaling'
      )
    }
  }
}
