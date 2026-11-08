import type { DevboxError } from '../shared/devbox-errors'
import type { DevboxExecRequest, DevboxExecResult } from './devbox-preflight'

export type DevboxRsyncSide = 'local' | 'remote'

export type DevboxRsyncEntryKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'device'
  | 'fifo'
  | 'socket'
  | 'unknown'

export type DevboxRsyncInventoryEntry = Readonly<{
  relativePath: string
  kind: DevboxRsyncEntryKind
  size: number
  sha256: string
  target?: string
}>

export type DevboxAdoptionClassification =
  | 'local-only'
  | 'remote-only'
  | 'identical'
  | 'divergent-same-path'
  | 'type-conflict'

export type DevboxAdoptionComparison = Readonly<{
  relativePath: string
  classification: DevboxAdoptionClassification
  local?: DevboxRsyncInventoryEntry
  remote?: DevboxRsyncInventoryEntry
}>

export type DevboxRsyncCapacityInput = Readonly<{
  freeBytes: number
  freeInodes: number
  leanSeedBytes?: number
  trackedRestoreBytes?: number
  stagingBytes?: number
  generationsBytes?: number
  generationBytes?: number
  syncStagingBytes?: number
  runtimeGenerationBytes?: number
  consistentWorkspaceBytes?: number
  blockReserveBytes?: number
  blockReserve?: number
  inodeReserve?: number
  estimatedInodes?: number
}>

export type DevboxRsyncCapacity = Readonly<
  DevboxRsyncCapacityInput & {
    requiredBytes: number
    requiredInodes: number
    byteDeficit: number
    inodeDeficit: number
  }
>

export type DevboxRsyncSeedPlan = Readonly<{
  source: DevboxRsyncSide
  destination: DevboxRsyncSide
  sourceRoot: string
  destinationRoot: string
  local: readonly DevboxRsyncInventoryEntry[]
  remote: readonly DevboxRsyncInventoryEntry[]
  comparisons: readonly DevboxAdoptionComparison[]
  bothNonEmpty: boolean
  requiresAcceptance: boolean
  digest: string
  capacity?: DevboxRsyncCapacity
}>

export type DevboxRsyncResolution = Readonly<{
  relativePath: string
  keep: DevboxRsyncSide
}>

export type DevboxRsyncAcceptance = Readonly<{
  accepted: boolean
  planDigest: string
  resolutions: readonly DevboxRsyncResolution[]
}>

export type DevboxRsyncExecRequest = DevboxExecRequest &
  Readonly<{
    cwd?: string
    stdin?: Uint8Array
  }>

export type DevboxRsyncSeedDependencies = Readonly<{
  exec: (request: DevboxRsyncExecRequest) => Promise<DevboxExecResult>
  writeFile?: (path: string, data: string | Uint8Array) => Promise<void>
  backup?: (request: { operationId: string; paths: readonly string[] }) => Promise<string>
  clock?: () => number
}>

export type DevboxRsyncSeedOptions = Readonly<{
  operationId?: string
  source?: DevboxRsyncSide
  signal?: AbortSignal
  stagingRoot?: string
  baselinePath?: string
  trackedListPath?: string
  filterPath?: string
  capacity?: DevboxRsyncCapacityInput
  plan?: DevboxRsyncSeedPlan
  acceptance?: DevboxRsyncAcceptance
  resolutions?: readonly DevboxRsyncResolution[]
  accepted?: boolean
}>

export type DevboxRsyncSeedResult = Readonly<{
  status: 'completed' | 'blocked' | 'cancelled' | 'noop'
  plan: DevboxRsyncSeedPlan
  manifestDigest?: string
  baselinePath: string
  backupPath?: string
  commands: number
  verifiedNoop?: boolean
  reason?:
    | 'plan-required'
    | 'unresolved-conflict'
    | 'type-conflict'
    | 'byte-deficit'
    | 'inode-deficit'
    | 'verification-failed'
    | 'rsync-failed'
  error?: DevboxError
}>
