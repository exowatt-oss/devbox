import type { DevboxError } from '../shared/devbox-errors'
import type {
  DevboxOperationEnvelope,
  DevboxOperationPhase,
  DevboxSshIdentity
} from '../shared/devbox-types'
import type { DevboxToolchainLockV1 } from '../shared/devbox-toolchain-lock'

export type DevboxExecRequest = {
  command: string
  args: readonly string[]
  signal?: AbortSignal
}

export type DevboxInventoryEntryKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'device'
  | 'fifo'
  | 'socket'
  | 'unknown'

export type DevboxInventoryEntry = {
  path: string
  kind: DevboxInventoryEntryKind
  target?: string
}

export type DevboxExecResult = {
  exitCode: number
  stdout: string
  stderr: string
  identity?: DevboxSshIdentity
  entries?: readonly DevboxInventoryEntry[]
}

export type DevboxExec = (request: DevboxExecRequest) => Promise<DevboxExecResult>

export type DevboxClock = () => number

export type DevboxCapacityEstimate = Record<
  | 'leanSeedBytes'
  | 'trackedRestoreBytes'
  | 'syncStagingBytes'
  | 'runtimeGenerationBytes'
  | 'consistentWorkspaceBytes'
  | 'blockReserveBytes'
  | 'inodeReserve',
  number
>

export type DevboxPreflightDependencies = {
  remoteExec: DevboxExec
  localExec: DevboxExec
  clock: DevboxClock
  capacityEstimator?: () => Promise<DevboxCapacityEstimate>
  toolchainLock?: DevboxToolchainLockV1
}

export type DevboxPreflightRunOptions = {
  operationId?: string
  signal?: AbortSignal
  capacity?: Partial<DevboxCapacityEstimate>
}

export type DevboxPreflightCheckId =
  | 'ssh-reachability'
  | 'host-identity'
  | 'os-distro-arch'
  | 'sudo'
  | 'systemd-user-manager'
  | 'user-linger'
  | 'remote-rsync'
  | 'remote-bash'
  | 'remote-python3'
  | 'remote-df'
  | 'free-bytes'
  | 'free-inodes'
  | 'ulimit'
  | 'path-safety'
  | 'capacity'
  | 'git-roaming'
  | 'ssh-proxy-route'

export type DevboxPreflightBlockReason =
  | 'ssh-unreachable'
  | 'ssh-identity-mismatch'
  | 'ssh-identity-unverified'
  | 'unsupported-os'
  | 'missing-sudo'
  | 'systemd-unhealthy'
  | 'linger-required'
  | 'insufficient-rsync'
  | 'missing-command'
  | 'byte-deficit'
  | 'inode-deficit'
  | 'path-conflict'
  | 'git-roaming-blocked'
  | 'ssh-proxy-route-missing'
  | 'preflight-unknown'

export type DevboxPreflightCheck = {
  id: DevboxPreflightCheckId
  status: 'pass' | 'warn' | 'fail' | 'unknown'
  remediation: string
  blocking: boolean
  details?: Record<string, string | number | boolean | readonly string[]>
  error?: DevboxError
}

export type DevboxPreflightStage = {
  id: string
  phase: DevboxOperationPhase
  status: 'pending' | 'running' | 'completed' | 'blocked' | 'cancelled'
  resumable: boolean
}

export type DevboxPreviewWrite = {
  path: string
  operation: 'create' | 'replace' | 'rename' | 'symlink'
  side: 'local' | 'remote'
}

export type DevboxPreviewPrivilege = {
  command: string
  args: readonly string[]
  reason: string
}

export type DevboxPreviewDownload = {
  artifactId: string
  sourceUrl: string
  sha256: string
  destination: string
}

export type DevboxPreflightPreview = {
  writes: readonly DevboxPreviewWrite[]
  privilegedCommands: readonly DevboxPreviewPrivilege[]
  downloads: readonly DevboxPreviewDownload[]
}

export type DevboxMeasuredCapacity = DevboxCapacityEstimate & {
  freeBytes: number
  freeInodes: number
  requiredBytes: number
  requiredInodes: number
  byteDeficit: number
  inodeDeficit: number
}

export type DevboxPathIssue = {
  path: string
  reason: string
  severity: 'warn' | 'block'
  candidates?: readonly string[]
}

export type DevboxPreflightResult = {
  status: 'ready' | 'blocked' | 'cancelled'
  operation: DevboxOperationEnvelope
  checks: readonly DevboxPreflightCheck[]
  stages: readonly DevboxPreflightStage[]
  preview: DevboxPreflightPreview
  blockedReason?: DevboxPreflightBlockReason
  blockers: readonly DevboxPreflightCheck[]
  capacity?: DevboxMeasuredCapacity
  pathIssues: readonly DevboxPathIssue[]
  pathSafety: 'pass' | 'warn' | 'block'
}
