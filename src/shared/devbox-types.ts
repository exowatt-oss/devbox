export const DEVBOX_PROFILE_SCHEMA_VERSION = 3 as const
export const DEVBOX_DEFAULT_MAX_ENTRY_COUNT = 2_000_000 as const
export const DEVBOX_DEFAULT_WATCH_POLLING_INTERVAL_SECONDS = 10 as const
export type DevboxProfileSchemaVersion = 1 | 2 | typeof DEVBOX_PROFILE_SCHEMA_VERSION

export type DevboxGitRoamingIgnore = {
  pattern: string
  rootClass: string
}
export type DevboxGitRoamingConfig = {
  enabled: boolean
  topology: 'working-tree-only'
  authorityScope: 'profile'
  parkedGitName: '.git.devbox-parked'
  refreshStrategy: 'origin'
  requireCleanHandoff: true
  requirePublishedHead: true
  excludeWorktrees: true
  ignorePatterns: readonly DevboxGitRoamingIgnore[]
}

export { DEVBOX_GIT_ROAMING_EXCLUSIONS } from './devbox-git-roaming-exclusions'
export type DevboxAuthorityOwner = 'local' | 'remote'
export type DevboxDefaultAuthority = DevboxAuthorityOwner
export type DevboxSshIdentity = {
  host: string
  port: number
  username: string
  hostKeyFingerprint: string
}
export type DevboxSshTargetReference = {
  targetId: string
  identity: DevboxSshIdentity
  /** Optional OpenSSH ProxyCommand (e.g. `devbox proxy`); absent = direct TCP to identity.host. */
  proxyCommand?: string
}
export type DevboxRootPair = { localRoot: string; remoteRoot: string }
export type DevboxCredentialSyncRoot = {
  id: string
  localRoot: string
  remoteRoot: string
  excludes: readonly string[]
}
export type DevboxCredentialSyncConfig = {
  enabled: boolean
  roots: readonly DevboxCredentialSyncRoot[]
}
/**
 * A one-way mirror of files matching `patterns` from a control-machine directory to a
 * remote directory. Used so clipboard-paste temp files written on the laptop resolve at
 * the very same absolute path on the remote host.
 */
export type DevboxPasteSyncRoot = {
  id: string
  localRoot: string
  remoteRoot: string
  /** Root-level file-name globs to mirror (everything else in the root is ignored). */
  patterns: readonly string[]
}
export type DevboxPasteSyncConfig = {
  enabled: boolean
  roots: readonly DevboxPasteSyncRoot[]
}
export type DevboxSyncBackend = 'mutagen' | 'rsync-fallback'
export type DevboxSyncClassConfig =
  | {
      id: string
      kind: 'portable-working'
      backend: DevboxSyncBackend
      mode: 'two-way-safe' | 'directional'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'portable-declarative'
      backend: DevboxSyncBackend
      mode: 'two-way-safe' | 'directional'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'git-durable'
      backend: 'rsync-fallback'
      mode: 'checkpoint-only'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'session-durable'
      backend: 'rsync-fallback'
      mode: 'authority-only'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'generated'
      backend: 'rsync-fallback'
      mode: 'rebuild-on-host'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'credentials'
      backend: 'rsync-fallback'
      mode: 'broker-only'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'stateful-service'
      backend: 'rsync-fallback'
      mode: 'host-local'
      excludes: readonly string[]
    }
  | {
      id: string
      kind: 'unsupported'
      backend: 'rsync-fallback'
      mode: 'excluded'
      excludes: readonly string[]
    }
export type DevboxPathMapEntry = {
  id: string
  localRelativePath: string
  remoteRelativePath: string
  syncClassId: string
}
export type DevboxSyncConfig = {
  classes: readonly DevboxSyncClassConfig[]
  defaultClassId: string
  excludes: readonly string[]
  /** Maximum entries Mutagen may scan when a new session is created. */
  maxEntryCount?: number
  /** Optional Mutagen watch polling override; absent means the 10-second default. */
  watchPollingIntervalSeconds?: number
}
export type DevboxToolchainLockReference = { lockId: string; lockSha256: string }
export type DevboxCredentialCapabilityDeclaration =
  | { kind: 'ssh-transport'; referenceId: string; targetId: string; delivery: 'devbox-managed' }
  | {
      kind: 'provider-auth'
      referenceId: string
      provider: 'github' | 'gitlab' | 'anthropic' | 'openai' | 'google' | 'custom'
      delivery: 'local-browser' | 'remote-enrollment'
    }
  | { kind: 'mcp-oauth'; referenceId: string; serverName: string; delivery: 'remote-bridge' }
export type DevboxProjectDefaults = {
  remoteTerminals: boolean
  remoteAgents: boolean
  remoteAutomations: boolean
}
export type DevboxFeatureDefaults = { detachedJobs: boolean; closedSessionHistory: boolean }
export type DevboxSloPolicy = {
  syncLagTargetMs: number
  reconnectTargetMs: number
  operationRecoveryTargetMs: number
  offlineEdits: 'allow' | 'warn' | 'block'
}
export type DevboxProfileV1 = {
  schemaVersion: DevboxProfileSchemaVersion
  id: string
  displayName: string
  /** Optional human-facing device alias used by --device and DEVBOX_PROFILE. */
  device?: string
  sshTarget: DevboxSshTargetReference
  roots: DevboxRootPair
  /** Optional absolute remote directory used for newly created interactive shells. */
  shellDir?: string
  /** Absolute path on the local control machine; values are never persisted here. */
  envFile?: string
  pathMap: readonly DevboxPathMapEntry[]
  toolchain: DevboxToolchainLockReference
  sync: DevboxSyncConfig
  /** Version 1 profiles omit this field and are migrated to a disabled contract. */
  gitRoaming?: DevboxGitRoamingConfig
  /** Optional per-root credential sync; absent means disabled. */
  credentialSync?: DevboxCredentialSyncConfig
  /** Optional one-way paste-file mirroring; absent means disabled. */
  pasteSync?: DevboxPasteSyncConfig
  credentials: readonly DevboxCredentialCapabilityDeclaration[]
  defaultAuthority: DevboxDefaultAuthority
  projectDefaults: DevboxProjectDefaults
  featureDefaults: DevboxFeatureDefaults
  slo: DevboxSloPolicy
}

export type DevboxOperationKind =
  | 'pair'
  | 'disable'
  | 'unpair'
  | 'preflight'
  | 'provision'
  | 'seed'
  | 'sync'
  | 'handoff'
  | 'repair'
  | 'run'
  | 'job'
  | 'auth'
  | 'doctor'
export type DevboxOperationPhase =
  | 'unpaired'
  | 'preflighting'
  | 'awaiting-review'
  | 'provisioning'
  | 'seeding'
  | 'baselining'
  | 'ready'
  | 'preparing'
  | 'quiescing'
  | 'checkpointing'
  | 'reconciling'
  | 'verifying'
  | 'committing-epoch'
  | 'resuming'
  | 'repairing'
  | 'blocked'
  | 'completed'
  | 'cancelled'
export type DevboxCancellation =
  | { requested: false }
  | { requested: true; requestedAt: number; reason: 'user' | 'shutdown' | 'superseded' }
export type DevboxOperationTimestamps = {
  startedAt: number
  updatedAt: number
  completedAt?: number
}
export type DevboxAuthorityEpoch = string & { readonly __devboxAuthorityEpoch: unique symbol }
export type DevboxAuthorityEpochRecord = {
  epoch: DevboxAuthorityEpoch
  sequence: number
  owner: DevboxAuthorityOwner
  observedAt: number
  committedAt: number
}
export type DevboxExecutionStatus =
  | { side: 'local' | 'remote'; state: 'idle' | 'running' | 'paused' | 'completed' | 'failed' }
  | { side: 'none'; state: 'idle' }
export type DevboxAuthorityStatus =
  | { side: 'local' | 'remote'; state: 'owner' | 'candidate' | 'quiesced' }
  | { side: 'none'; state: 'unpaired' }
export type DevboxFreshnessStatus =
  | { state: 'fresh'; observedAt: number }
  | { state: 'stale'; observedAt: number; staleSince: number }
  | { state: 'unknown' }
export type DevboxConflictStatus =
  | { state: 'none' }
  | { state: 'present' | 'deferred'; pathCount: number }
export type DevboxDriftStatus =
  | { state: 'none' }
  | { state: 'detected'; components: readonly ('toolchain' | 'config' | 'host')[] }
export type DevboxConnectivityStatus =
  | { state: 'online' }
  | { state: 'offline'; since: number }
  | { state: 'partial'; reason: 'sync' | 'ssh' | 'watcher' }
export type DevboxAuthStatus =
  | { state: 'healthy' }
  | { state: 'required' | 'expired'; capabilities: readonly string[] }
  | { state: 'unknown' }
export type DevboxDiskStatus =
  | { state: 'healthy'; freeBytes?: number }
  | { state: 'pressure'; freeBytes?: number; requiredBytes?: number }
  | { state: 'full'; freeBytes?: number }
  | { state: 'unknown' }
export type DevboxOperationStatus = {
  execution: DevboxExecutionStatus
  authority: DevboxAuthorityStatus
  freshness: DevboxFreshnessStatus
  conflict: DevboxConflictStatus
  drift: DevboxDriftStatus
  connectivity: DevboxConnectivityStatus
  auth: DevboxAuthStatus
  disk: DevboxDiskStatus
}
export type DevboxOperationEnvelope = {
  operationId: string
  kind: DevboxOperationKind
  phase: DevboxOperationPhase
  idempotencyKey: string
  cancellation: DevboxCancellation
  timestamps: DevboxOperationTimestamps
  authorityEpoch: DevboxAuthorityEpochRecord
  status: DevboxOperationStatus
}

type EpochValue = Record<string, unknown>
const epochObject = (value: unknown): value is EpochValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export function isDevboxAuthorityEpochRecord(input: unknown): input is DevboxAuthorityEpochRecord {
  return (
    epochObject(input) &&
    typeof input.epoch === 'string' &&
    input.epoch.length > 0 &&
    typeof input.sequence === 'number' &&
    Number.isSafeInteger(input.sequence) &&
    input.sequence >= 0 &&
    (input.owner === 'local' || input.owner === 'remote') &&
    typeof input.observedAt === 'number' &&
    Number.isSafeInteger(input.observedAt) &&
    input.observedAt >= 0 &&
    typeof input.committedAt === 'number' &&
    Number.isSafeInteger(input.committedAt) &&
    input.committedAt >= input.observedAt
  )
}
export const isMonotonicDevboxAuthorityEpoch = (
  previous: DevboxAuthorityEpochRecord,
  next: DevboxAuthorityEpochRecord
): boolean => next.sequence > previous.sequence && next.epoch !== previous.epoch
