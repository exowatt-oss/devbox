import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { DevboxOperationJournal } from '../devbox-operation-journal'
import type {
  DevboxAuthorityEpoch,
  DevboxAuthorityEpochRecord,
  DevboxAuthorityOwner,
  DevboxOperationEnvelope,
  DevboxOperationPhase
} from '../../shared/devbox-types'

export const DEVBOX_AUTHORITY_WITNESS_SCHEMA_VERSION = 1 as const
export type DevboxAuthorityWitnessKind = 'host-local' | 'peer-observed'
export type DevboxAuthorityWitnessStage =
  | 'prepared'
  | 'quiesced'
  | 'checkpointed'
  | 'reconciled'
  | 'verified'
  | 'committed'
  | 'rolled-back'
export type DevboxAuthorityWitnessRecord = {
  schemaVersion: typeof DEVBOX_AUTHORITY_WITNESS_SCHEMA_VERSION
  profileId: string
  witnessId: string
  kind: DevboxAuthorityWitnessKind
  transitionId: string
  stage: DevboxAuthorityWitnessStage
  previousEpoch: DevboxAuthorityEpochRecord
  candidateEpoch: DevboxAuthorityEpochRecord
  effectiveEpoch: DevboxAuthorityEpochRecord
  stateFingerprint: string
  updatedAt: number
  checksum: string
}
export type DevboxAuthorityWitnessObservation = Readonly<{
  transitionId: string
  stage: DevboxAuthorityWitnessStage
  previousEpoch: DevboxAuthorityEpochRecord
  candidateEpoch: DevboxAuthorityEpochRecord
  effectiveEpoch: DevboxAuthorityEpochRecord
  stateFingerprint: string
  updatedAt: number
}>
export type DevboxAuthorityWitnessReadResult =
  | { status: 'missing' }
  | { status: 'valid'; record: DevboxAuthorityWitnessRecord }
  | { status: 'corrupt'; reason: 'invalid-json' | 'invalid-record' | 'wrong-witness' }
export type DevboxAuthorityWitnessOptions = Readonly<{
  profileId: string
  kind: DevboxAuthorityWitnessKind
  witnessId?: string
  path?: string
}>
// oxfmt-ignore
export type DevboxAuthorityErrorCode = 'split_authority' | 'stale_epoch' | 'writer_not_acknowledged' | 'external_drift' | 'transition_blocked' | 'witness_corrupt' | 'journal_unavailable'
// oxfmt-ignore
export type DevboxAuthorityError = { code: DevboxAuthorityErrorCode; message: string; retryable: boolean; culprit?: string; evidence?: Readonly<Record<string, string | number>> }
// oxfmt-ignore
export type DevboxAuthorityTransitionStage = 'prepare' | 'quiesce' | 'checkpoint' | 'reconcile' | 'verify' | 'commit-epoch' | 'resume' | 'rollback'
// oxfmt-ignore
export type DevboxAuthorityQuiesceRequest = { operationId: string; transitionId: string; currentEpoch: DevboxAuthorityEpoch; targetOwner: DevboxAuthorityOwner }
// oxfmt-ignore
export type DevboxAuthorityQuiesceAck = { writerId: string; acknowledged: boolean; epoch: DevboxAuthorityEpoch }
// oxfmt-ignore
export type DevboxAuthorityManagedWriter = { writerId: string; kind: 'sync-supervisor' | 'provisioner' | 'agent-launcher' | string; epoch: DevboxAuthorityEpoch;
  quiesce: (request: DevboxAuthorityQuiesceRequest) => DevboxAuthorityQuiesceAck | Promise<DevboxAuthorityQuiesceAck> }
// oxfmt-ignore
export type DevboxAuthorityEpochManagerOptions = { profileId: string; journal: DevboxOperationJournal; witnesses: readonly [DevboxAuthorityWitness, DevboxAuthorityWitness];
  initialEpoch?: DevboxAuthorityEpochRecord; now?: () => number; epochFactory?: (sequence: number, owner: DevboxAuthorityOwner) => DevboxAuthorityEpoch;
  stateFingerprint?: () => string; quiesceTimeoutMs?: number }
// oxfmt-ignore
export type DevboxAuthorityAcquireRequest = { targetOwner: DevboxAuthorityOwner; operationId?: string; idempotencyKey?: string;
  expectedEpoch?: DevboxAuthorityEpoch | DevboxAuthorityEpochRecord; crashAt?: DevboxAuthorityTransitionStage }
// oxfmt-ignore
export type DevboxAuthorityAcquisition = { status: 'acquired'; operationId: string; idempotencyKey: string; transitionId: string;
  previousEpoch: DevboxAuthorityEpochRecord; candidateEpoch: DevboxAuthorityEpochRecord; baselineFingerprint?: string }
// oxfmt-ignore
export type DevboxAuthorityResult = { status: 'committed' | 'replayed' | 'released' | 'blocked'; operationId: string;
  transitionId: string; epoch: DevboxAuthorityEpochRecord; error?: DevboxAuthorityError }
// oxfmt-ignore
export type DevboxAuthorityEpochCheck = { status: 'accepted'; epoch: DevboxAuthorityEpochRecord } | { status: 'rejected'; error: DevboxAuthorityError }
// oxfmt-ignore
export type DevboxAuthorityRecovery = { status: 'clean' | 'committed' | 'rolled-back' | 'blocked'; epoch?: DevboxAuthorityEpochRecord; error?: DevboxAuthorityError }

type UnsignedRecord = Omit<DevboxAuthorityWitnessRecord, 'checksum'>
type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const owner = (value: unknown): value is DevboxAuthorityOwner =>
  value === 'local' || value === 'remote'
const epoch = (value: unknown): value is DevboxAuthorityEpochRecord =>
  object(value) &&
  typeof value.epoch === 'string' &&
  value.epoch.length > 0 &&
  typeof value.sequence === 'number' &&
  Number.isSafeInteger(value.sequence) &&
  value.sequence >= 0 &&
  owner(value.owner) &&
  typeof value.observedAt === 'number' &&
  Number.isSafeInteger(value.observedAt) &&
  value.observedAt >= 0 &&
  typeof value.committedAt === 'number' &&
  Number.isSafeInteger(value.committedAt) &&
  value.committedAt >= value.observedAt
const stage = (value: unknown): value is DevboxAuthorityWitnessStage =>
  value === 'prepared' ||
  value === 'quiesced' ||
  value === 'checkpointed' ||
  value === 'reconciled' ||
  value === 'verified' ||
  value === 'committed' ||
  value === 'rolled-back'
const unsigned = (record: DevboxAuthorityWitnessRecord): UnsignedRecord => {
  const { checksum: _checksum, ...value } = record
  void _checksum
  return value
}
const checksum = (value: UnsignedRecord): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

// oxfmt-ignore
export const DEVBOX_AUTHORITY_PHASES: Record<DevboxAuthorityTransitionStage, DevboxOperationPhase> = { prepare: 'preparing', quiesce: 'quiescing', checkpoint: 'checkpointing',
  reconcile: 'reconciling', verify: 'verifying', 'commit-epoch': 'committing-epoch', resume: 'resuming', rollback: 'cancelled' }
// oxfmt-ignore
export const DEVBOX_AUTHORITY_WITNESS_STAGES: Record<DevboxAuthorityTransitionStage, DevboxAuthorityWitnessStage> = { prepare: 'prepared', quiesce: 'quiesced', checkpoint: 'checkpointed',
  reconcile: 'reconciled', verify: 'verified', 'commit-epoch': 'committed', resume: 'committed', rollback: 'rolled-back' }
// oxfmt-ignore
export const sameDevboxAuthorityEpoch = (a: DevboxAuthorityEpochRecord, b: DevboxAuthorityEpochRecord): boolean => a.epoch === b.epoch && a.sequence === b.sequence && a.owner === b.owner
// oxfmt-ignore
export const sameDevboxAuthorityTransition = (a: DevboxAuthorityWitnessRecord, b: DevboxAuthorityWitnessRecord): boolean => a.transitionId === b.transitionId &&
  sameDevboxAuthorityEpoch(a.previousEpoch, b.previousEpoch) && sameDevboxAuthorityEpoch(a.candidateEpoch, b.candidateEpoch)
// oxfmt-ignore
export const createDevboxAuthorityError = (code: DevboxAuthorityErrorCode, message: string, retryable: boolean,
  culprit?: string, evidence?: Readonly<Record<string, string | number>>): DevboxAuthorityError => ({ code, message, retryable,
  ...(culprit ? { culprit } : {}), ...(evidence ? { evidence } : {}) })

// oxfmt-ignore
export type DevboxAuthorityWitnessPair = { status: 'ok'; records: [DevboxAuthorityWitnessRecord, DevboxAuthorityWitnessRecord] } | { status: 'missing' | 'split' | 'corrupt' }

// oxfmt-ignore
export function readDevboxAuthorityWitnessPair(witnesses: readonly [DevboxAuthorityWitness, DevboxAuthorityWitness]): DevboxAuthorityWitnessPair {
  const reads = witnesses.map((witness) => witness.read())
  if (reads.every((read) => read.status === 'missing')) {
    return { status: 'missing' }
  }
  if (reads.some((read) => read.status !== 'valid')) {
    return { status: 'corrupt' }
  }
  const records = reads.map((read) => read.status === 'valid' ? read.record : undefined) as [DevboxAuthorityWitnessRecord, DevboxAuthorityWitnessRecord]
  const [first, second] = records
  if (!sameDevboxAuthorityTransition(first, second) || first.stage !== second.stage ||
    !sameDevboxAuthorityEpoch(first.effectiveEpoch, second.effectiveEpoch) || first.stateFingerprint !== second.stateFingerprint) {
    return { status: 'split' }
  }
  return { status: 'ok', records: [first, second] }
}

// oxfmt-ignore
export function makeDevboxAuthorityOperation(acquisition: DevboxAuthorityAcquisition, operationPhase: DevboxOperationPhase, epoch: DevboxAuthorityEpochRecord, now: number): DevboxOperationEnvelope {
  const state = operationPhase === 'completed' ? 'completed' : 'paused'
  const authority = operationPhase === 'completed' ? 'owner' : 'quiesced'
  const status: DevboxOperationEnvelope['status'] = { execution: { side: epoch.owner, state }, authority: { side: epoch.owner, state: authority }, freshness: { state: 'fresh' as const, observedAt: now },
    conflict: { state: 'none' as const }, drift: { state: 'none' as const }, connectivity: { state: 'online' as const }, auth: { state: 'healthy' as const }, disk: { state: 'healthy' as const } }
  return { operationId: `${acquisition.transitionId}:${operationPhase}`, kind: 'handoff', phase: operationPhase, idempotencyKey: acquisition.idempotencyKey,
    cancellation: { requested: false }, timestamps: { startedAt: epoch.observedAt, updatedAt: now }, authorityEpoch: epoch, status }
}

export function isDevboxAuthorityWitnessRecord(
  value: unknown
): value is DevboxAuthorityWitnessRecord {
  if (!object(value)) {
    return false
  }
  if (
    value.schemaVersion !== DEVBOX_AUTHORITY_WITNESS_SCHEMA_VERSION ||
    typeof value.profileId !== 'string' ||
    value.profileId.length === 0 ||
    typeof value.witnessId !== 'string' ||
    value.witnessId.length === 0 ||
    (value.kind !== 'host-local' && value.kind !== 'peer-observed') ||
    typeof value.transitionId !== 'string' ||
    value.transitionId.length === 0 ||
    !stage(value.stage) ||
    !epoch(value.previousEpoch) ||
    !epoch(value.candidateEpoch) ||
    !epoch(value.effectiveEpoch) ||
    typeof value.stateFingerprint !== 'string' ||
    typeof value.updatedAt !== 'number' ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0 ||
    typeof value.checksum !== 'string' ||
    value.checksum.length === 0
  ) {
    return false
  }
  return value.checksum === checksum(unsigned(value as DevboxAuthorityWitnessRecord))
}

export class DevboxAuthorityWitness {
  readonly profileId: string
  readonly kind: DevboxAuthorityWitnessKind
  readonly witnessId: string
  private readonly path?: string
  private record?: DevboxAuthorityWitnessRecord

  constructor(options: DevboxAuthorityWitnessOptions) {
    this.profileId = options.profileId
    this.kind = options.kind
    this.witnessId = options.witnessId ?? `${options.kind}:${options.profileId}`
    this.path = options.path
  }

  read(): DevboxAuthorityWitnessReadResult {
    const raw = this.path
      ? existsSync(this.path)
        ? readFileSync(this.path, 'utf8')
        : undefined
      : this.record
        ? JSON.stringify(this.record)
        : undefined
    if (raw === undefined) {
      return { status: 'missing' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'corrupt', reason: 'invalid-json' }
    }
    if (!isDevboxAuthorityWitnessRecord(parsed)) {
      return { status: 'corrupt', reason: 'invalid-record' }
    }
    if (
      parsed.profileId !== this.profileId ||
      parsed.witnessId !== this.witnessId ||
      parsed.kind !== this.kind
    ) {
      return { status: 'corrupt', reason: 'wrong-witness' }
    }
    return { status: 'valid', record: parsed }
  }

  observe(input: DevboxAuthorityWitnessObservation): DevboxAuthorityWitnessRecord {
    const value: UnsignedRecord = {
      schemaVersion: DEVBOX_AUTHORITY_WITNESS_SCHEMA_VERSION,
      profileId: this.profileId,
      witnessId: this.witnessId,
      kind: this.kind,
      transitionId: input.transitionId,
      stage: input.stage,
      previousEpoch: input.previousEpoch,
      candidateEpoch: input.candidateEpoch,
      effectiveEpoch: input.effectiveEpoch,
      stateFingerprint: input.stateFingerprint,
      updatedAt: input.updatedAt
    }
    const record = { ...value, checksum: checksum(value) }
    if (this.path) {
      this.writeFile(`${JSON.stringify(record, null, 2)}\n`)
    } else {
      this.record = record
    }
    return record
  }

  write(record: DevboxAuthorityWitnessRecord): void {
    if (!isDevboxAuthorityWitnessRecord(record)) {
      throw new Error('Invalid authority witness record.')
    }
    if (
      record.profileId !== this.profileId ||
      record.witnessId !== this.witnessId ||
      record.kind !== this.kind
    ) {
      throw new Error('Authority witness identity mismatch.')
    }
    if (this.path) {
      this.writeFile(`${JSON.stringify(record, null, 2)}\n`)
    } else {
      this.record = record
    }
  }

  clear(): void {
    this.record = undefined
  }

  private writeFile(raw: string): void {
    const path = this.path!
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const descriptor = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(descriptor, raw, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
  }
}
