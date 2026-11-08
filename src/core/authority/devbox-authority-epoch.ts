import { randomUUID } from 'node:crypto'
import type {
  DevboxAuthorityEpoch,
  DevboxAuthorityEpochRecord,
  DevboxAuthorityOwner
} from '../../shared/devbox-types'
import {
  type DevboxAuthorityAcquisition,
  type DevboxAuthorityAcquireRequest,
  type DevboxAuthorityEpochCheck,
  type DevboxAuthorityError,
  type DevboxAuthorityEpochManagerOptions,
  type DevboxAuthorityManagedWriter,
  type DevboxAuthorityQuiesceRequest,
  type DevboxAuthorityRecovery,
  type DevboxAuthorityResult,
  type DevboxAuthorityTransitionStage,
  type DevboxAuthorityWitnessObservation,
  DEVBOX_AUTHORITY_PHASES,
  DEVBOX_AUTHORITY_WITNESS_STAGES,
  createDevboxAuthorityError,
  makeDevboxAuthorityOperation,
  readDevboxAuthorityWitnessPair,
  sameDevboxAuthorityTransition
} from './devbox-authority-witness'

export type * from './devbox-authority-witness'

const fail = createDevboxAuthorityError
const phases = DEVBOX_AUTHORITY_PHASES
const stages = DEVBOX_AUTHORITY_WITNESS_STAGES

export class DevboxAuthorityCrash extends Error {
  constructor(readonly stage: DevboxAuthorityTransitionStage) {
    super(`Injected Devbox authority crash at ${stage}.`)
    this.name = 'DevboxAuthorityCrash'
  }
}

// oxfmt-ignore
export class DevboxAuthorityEpochManager {
  // This is cooperative fencing, not an OS lock: an arbitrary same-user shell can still write.
  private readonly writers = new Map<string, DevboxAuthorityManagedWriter>()
  private readonly now: () => number
  private readonly epoch: (sequence: number, owner: DevboxAuthorityOwner) => DevboxAuthorityEpoch
  private readonly timeout: number
  private active?: string

  constructor(private readonly options: DevboxAuthorityEpochManagerOptions) {
    this.now = options.now ?? Date.now
    this.epoch = options.epochFactory ?? ((sequence, owner) => `authority:${options.profileId}:${sequence}:${owner}:${randomUUID()}` as DevboxAuthorityEpoch)
    this.timeout = options.quiesceTimeoutMs ?? 5_000
    if (options.witnesses.length !== 2 || new Set(options.witnesses.map((witness) => witness.kind)).size !== 2) {
      throw new Error('Devbox authority requires independent local and peer witnesses.')
    }
  }

  registerWriter(writer: DevboxAuthorityManagedWriter): void {
    this.writers.set(writer.writerId, writer)
  }

// oxfmt-ignore
  currentEpoch(): DevboxAuthorityEpochRecord | null {
    const pair = readDevboxAuthorityWitnessPair(this.options.witnesses)
    return pair.status === 'ok' ? pair.records[0].effectiveEpoch : pair.status === 'missing' ? this.options.initialEpoch ?? null : null
  }

  validateEpoch(epoch: DevboxAuthorityEpoch | DevboxAuthorityEpochRecord): DevboxAuthorityEpochCheck {
    const current = this.currentEpoch()
    const received = typeof epoch === 'string' ? epoch : epoch.epoch
    if (!current || current.epoch !== received) {
      const error = fail('stale_epoch', 'The managed operation carries a stale authority epoch.', false, undefined, { expectedEpoch: current?.epoch ?? 'none', receivedEpoch: received })
      return { status: 'rejected', error }
    }
    return { status: 'accepted', epoch: current }
  }

  acquire(request: DevboxAuthorityAcquireRequest): DevboxAuthorityAcquisition | DevboxAuthorityResult {
    const recovered = this.recover()
    const operationId = request.operationId ?? `handoff-${randomUUID()}`
    if (recovered.status === 'blocked') {
      return this.blocked(operationId, recovered.error!)
    }
    const key = request.idempotencyKey ?? `authority:${this.options.profileId}:${operationId}`
    const replay = this.completed(key)
    if (replay) {
      return { status: 'replayed', operationId, transitionId: replay.id, epoch: replay.epoch }
    }
    const current = this.ensure()
    if ('code' in current) {
      return this.blocked(operationId, current)
    }
    const expected = typeof request.expectedEpoch === 'string' ? request.expectedEpoch : request.expectedEpoch?.epoch
    if (expected && expected !== current.epoch) {
      return this.blocked(operationId, fail('stale_epoch', 'The requested handoff starts from a stale epoch.', false, undefined, { expectedEpoch: current.epoch, receivedEpoch: expected }))
    }
    if (current.owner === request.targetOwner) {
      return { status: 'replayed', operationId, transitionId: 'no-op', epoch: current }
    }
    if (this.active) {
      return this.blocked(operationId, fail('transition_blocked', 'Another authority transition owns this profile.', true))
    }
    // oxfmt-ignore
    const candidate = {
      epoch: this.epoch(current.sequence + 1, request.targetOwner), sequence: current.sequence + 1,
      owner: request.targetOwner, observedAt: this.now(), committedAt: this.now()
    }
    // oxfmt-ignore
    const acquisition: DevboxAuthorityAcquisition = {
      status: 'acquired', operationId, idempotencyKey: key, transitionId: `${operationId}:${randomUUID()}`,
      previousEpoch: current, candidateEpoch: candidate,
      ...(this.options.stateFingerprint ? { baselineFingerprint: this.options.stateFingerprint() } : {})
    }
    try {
      this.recordJournal(acquisition, 'prepare', current)
      this.writeStage(acquisition, 'prepare', current)
      this.crash(request.crashAt, 'prepare')
      this.active = acquisition.transitionId
      return acquisition
    } catch (error) {
      if (error instanceof DevboxAuthorityCrash) {
        throw error
      }
      return this.blocked(operationId, error as DevboxAuthorityError)
    }
  }

  async commit(acquisition: DevboxAuthorityAcquisition, crashAt?: DevboxAuthorityTransitionStage): Promise<DevboxAuthorityResult> {
    const replay = this.completed(acquisition.idempotencyKey)
    if (replay) {
      return { status: 'replayed', operationId: acquisition.operationId, transitionId: replay.id, epoch: replay.epoch }
    }
    const check = this.validateEpoch(acquisition.previousEpoch.epoch)
    if (check.status === 'rejected') {
      return this.blocked(acquisition.operationId, check.error)
    }
    try {
      const quiesce = () => Promise.all([...this.writers.values()].map((writer) => this.quiesceWriter(writer, acquisition))).then(() => undefined)
      await this.step(acquisition, 'quiesce', acquisition.previousEpoch, crashAt, quiesce)
      await this.step(acquisition, 'checkpoint', acquisition.previousEpoch, crashAt)
      await this.step(acquisition, 'reconcile', acquisition.previousEpoch, crashAt)
      await this.step(acquisition, 'verify', acquisition.previousEpoch, crashAt, () => this.verify(acquisition))
      await this.step(acquisition, 'commit-epoch', acquisition.candidateEpoch, crashAt)
      await this.step(acquisition, 'resume', acquisition.candidateEpoch, crashAt)
      this.recordJournal(acquisition, 'completed', acquisition.candidateEpoch)
      this.active = undefined
      return { status: 'committed', operationId: acquisition.operationId, transitionId: acquisition.transitionId, epoch: acquisition.candidateEpoch }
    } catch (error) {
      if (error instanceof DevboxAuthorityCrash) {
        throw error
      }
      const result = this.rollback(acquisition, error as DevboxAuthorityError)
      this.active = undefined
      return result
    }
  }

  release(acquisition: DevboxAuthorityAcquisition): DevboxAuthorityResult {
    const current = this.currentEpoch()
    if (!current || current.epoch !== acquisition.candidateEpoch.epoch) {
      return this.blocked(acquisition.operationId, fail('stale_epoch', 'Only the current managed epoch can be released.', false))
    }
    this.active = undefined
    return { status: 'released', operationId: acquisition.operationId, transitionId: acquisition.transitionId, epoch: current }
  }

  recover(): DevboxAuthorityRecovery {
    const replay = this.options.journal.replay()
    if (replay.status !== 'ok') {
      return { status: 'blocked', error: fail('journal_unavailable', 'The authority journal cannot be replayed.', true) }
    }
    const pending = replay.operations.filter(
      (operation) => operation.kind === 'handoff' && operation.idempotencyKey.startsWith(`authority:${this.options.profileId}:`) && operation.phase !== 'completed' && operation.phase !== 'cancelled'
    )
    if (pending.length === 0) {
      return { status: 'clean' }
    }
    const pair = readDevboxAuthorityWitnessPair(this.options.witnesses)
    if (pair.status !== 'ok' || !sameDevboxAuthorityTransition(pair.records[0], pair.records[1])) {
      const code = pair.status === 'corrupt' ? 'witness_corrupt' : 'split_authority'
      return { status: 'blocked', error: fail(code, 'The authority witnesses disagree during recovery.', false) }
    }
    const record = pair.records[0]
    const operation = pending[0]!
    const acquisition: DevboxAuthorityAcquisition = {
      status: 'acquired', operationId: operation.operationId.split(':')[0]!, idempotencyKey: operation.idempotencyKey,
      transitionId: record.transitionId, previousEpoch: record.previousEpoch, candidateEpoch: record.candidateEpoch,
      ...(record.stateFingerprint === 'unknown' ? {} : { baselineFingerprint: record.stateFingerprint })
    }
    if (record.stage === 'committed') {
      this.recordJournal(acquisition, 'completed', acquisition.candidateEpoch)
      return { status: 'committed', epoch: record.effectiveEpoch }
    }
    const result = this.rollback(acquisition, fail('transition_blocked', 'The interrupted authority transition was rolled back.', true))
    return result.status === 'blocked' ? { status: 'rolled-back', epoch: result.epoch } : { status: 'blocked', error: result.error }
  }

  private ensure(): DevboxAuthorityEpochRecord | DevboxAuthorityError {
    const pair = readDevboxAuthorityWitnessPair(this.options.witnesses)
    if (pair.status === 'ok') {
      return pair.records[0].effectiveEpoch
    }
    if (pair.status !== 'missing') {
      return pair.status === 'corrupt'
        ? fail('witness_corrupt', 'An authority witness is corrupt or invalid.', false)
        : fail('split_authority', 'The host-local and peer-observed witnesses disagree.', false)
    }
    const now = this.now()
    const epoch = this.options.initialEpoch ?? {
      epoch: `initial:${this.options.profileId}` as DevboxAuthorityEpoch, sequence: 0, owner: 'local' as const,
      observedAt: now, committedAt: now
    }
    const error = this.writeBoth({
      transitionId: `initial:${this.options.profileId}`, stage: 'committed', previousEpoch: epoch,
      candidateEpoch: epoch, effectiveEpoch: epoch,
      stateFingerprint: this.options.stateFingerprint?.() ?? 'unknown', updatedAt: now
    })
    return error ?? epoch
  }

// oxfmt-ignore
  private async step(acquisition: DevboxAuthorityAcquisition, name: DevboxAuthorityTransitionStage, effective: DevboxAuthorityEpochRecord,
    crashAt: DevboxAuthorityTransitionStage | undefined, action?: () => void | Promise<void>): Promise<void> {
    this.recordJournal(acquisition, name, effective)
    await action?.()
    this.writeStage(acquisition, name, effective)
    this.crash(crashAt, name)
  }

// oxfmt-ignore
  private async quiesceWriter(writer: DevboxAuthorityManagedWriter, acquisition: DevboxAuthorityAcquisition): Promise<void> {
    const request: DevboxAuthorityQuiesceRequest = {
      operationId: acquisition.operationId, transitionId: acquisition.transitionId,
      currentEpoch: acquisition.previousEpoch.epoch, targetOwner: acquisition.candidateEpoch.owner
    }
    const timeout = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), this.timeout)
      timer.unref?.()
    })
    const ack = await Promise.race([Promise.resolve(writer.quiesce(request)), timeout])
    if (!ack || !ack.acknowledged || ack.writerId !== writer.writerId || ack.epoch !== request.currentEpoch) {
      throw fail('writer_not_acknowledged', 'A managed writer did not acknowledge quiescing.', true, writer.writerId, { timeoutMs: this.timeout })
    }
  }

  private verify(acquisition: DevboxAuthorityAcquisition): void {
    if (!this.options.stateFingerprint || acquisition.baselineFingerprint === undefined) {
      return
    }
    const observed = this.options.stateFingerprint()
    if (observed !== acquisition.baselineFingerprint) {
      throw fail('external_drift', 'Unmanaged state changed during the authority transition.', false, undefined, {
        baselineFingerprint: acquisition.baselineFingerprint, observedFingerprint: observed, observedAt: this.now()
      })
    }
  }

// oxfmt-ignore
  private writeStage(acquisition: DevboxAuthorityAcquisition, name: DevboxAuthorityTransitionStage, effective: DevboxAuthorityEpochRecord): void {
    const error = this.writeBoth({
      transitionId: acquisition.transitionId, stage: stages[name], previousEpoch: acquisition.previousEpoch,
      candidateEpoch: acquisition.candidateEpoch, effectiveEpoch: effective,
      stateFingerprint: acquisition.baselineFingerprint ?? 'unknown', updatedAt: this.now()
    })
    if (error) {
      throw error
    }
  }

  private writeBoth(input: DevboxAuthorityWitnessObservation): DevboxAuthorityError | undefined {
    try {
      for (const witness of this.options.witnesses) {
        witness.observe(input)
      }
      return undefined
    } catch {
      return fail('witness_corrupt', 'An authority witness rejected a transition record.', false)
    }
  }

  private recordJournal(acquisition: DevboxAuthorityAcquisition, name: DevboxAuthorityTransitionStage | 'completed', epoch: DevboxAuthorityEpochRecord): void {
    const operationPhase = name === 'completed' ? 'completed' : phases[name]
    const result = this.options.journal.append(makeDevboxAuthorityOperation(acquisition, operationPhase, epoch, this.now()), { recordId: `${acquisition.transitionId}:${name}` })
    if (result.status !== 'written') {
      throw fail('journal_unavailable', 'The authority transition could not be journaled.', true)
    }
  }

  private rollback(acquisition: DevboxAuthorityAcquisition, failure: DevboxAuthorityError): DevboxAuthorityResult {
    const pair = readDevboxAuthorityWitnessPair(this.options.witnesses)
    if (pair.status !== 'ok' || !sameDevboxAuthorityTransition(pair.records[0], pair.records[1]) || pair.records[0].transitionId !== acquisition.transitionId) {
      return this.blocked(acquisition.operationId, fail('split_authority', 'Rollback stopped on divergent witness evidence.', false))
    }
    try {
      this.recordJournal(acquisition, 'rollback', acquisition.previousEpoch)
      this.writeStage(acquisition, 'rollback', acquisition.previousEpoch)
      return { status: 'blocked', operationId: acquisition.operationId, transitionId: acquisition.transitionId, epoch: acquisition.previousEpoch, error: failure }
    } catch {
      return this.blocked(acquisition.operationId, fail('transition_blocked', 'The transition needs explicit recovery.', true))
    }
  }

  private completed(key: string): { id: string; epoch: DevboxAuthorityEpochRecord } | undefined {
    const replay = this.options.journal.replay()
    if (replay.status !== 'ok') {
      return undefined
    }
    const operation = replay.operations.find((entry) => entry.idempotencyKey === key && entry.phase === 'completed')
    if (!operation) {
      return undefined
    }
    const transitionId = operation.operationId.split(':').at(-2) ?? 'replayed'
    return { id: transitionId, epoch: operation.authorityEpoch }
  }

  private blocked(operationId: string, error: DevboxAuthorityError): DevboxAuthorityResult {
    return { status: 'blocked', operationId, transitionId: 'unassigned', epoch: this.currentEpoch() ?? this.options.initialEpoch!, error }
  }

  private crash(requested: DevboxAuthorityTransitionStage | undefined, actual: DevboxAuthorityTransitionStage): void {
    if (requested === actual) {
      throw new DevboxAuthorityCrash(actual)
    }
  }

}
