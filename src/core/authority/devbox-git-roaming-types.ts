import type { DevboxAuthorityOwner, DevboxGitRoamingConfig } from '../../shared/devbox-types'

export type DevboxGitRoamingSide = DevboxAuthorityOwner
export type DevboxGitRoamingTopology = 'active' | 'parked' | 'mixed' | 'missing'
export type DevboxGitRoamingTransition =
  | 'idle'
  | 'candidate'
  | 'quiesced'
  | 'reconciling'
  | 'committed'
  | 'blocked'

export type DevboxGitRoamingCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type DevboxGitRoamingWarning = {
  code: 'origin-missing' | 'fetch-failed' | 'passive-object-missing' | 'handoff-required'
  message: string
  side?: DevboxGitRoamingSide
  repository?: string
  stderr?: string
}
export type DevboxGitRoamingCommand = (
  cwd: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>
) => Promise<DevboxGitRoamingCommandResult>

export type DevboxGitRoamingFileSystem = {
  exists(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  readFile(path: string): Promise<string | undefined>
  list(path: string): Promise<readonly { name: string; directory: boolean }[]>
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, value: string): Promise<void>
  syncDirectory(path: string): Promise<void>
}

export type DevboxGitRoamingHost = {
  root: string
  run: DevboxGitRoamingCommand
  files: DevboxGitRoamingFileSystem
}

export type DevboxGitRoamingRepository = {
  relativePath: string
  path: string
  gitPath: string
  parkedPath: string
  commandGitPath: string
  metadataKind: 'directory' | 'file' | 'missing'
  topology: DevboxGitRoamingTopology
  branch: string | null
  head: string | null
  clean: boolean
  dirtyReason?: string
  detached: boolean
  activeOperation: string | null
  linkedWorktree: boolean
  submoduleState: 'none' | 'initialized' | 'uninitialized' | 'inconsistent'
  origin: string | null
  published: boolean
  objectReachable: boolean
  treeFingerprint: string
  excludedTrackedPaths: readonly string[]
}

export type DevboxGitRoamingInventory = {
  side: DevboxGitRoamingSide
  root: string
  repositories: readonly DevboxGitRoamingRepository[]
  manifestDigest: string
  dirtyRepositories: number
  unpublishedRepositories: number
  blockers: readonly DevboxGitRoamingBlocker[]
  observedAt: number
}

export type DevboxGitRoamingBlocker = {
  code:
  | 'root-mismatch'
  | 'missing-repository'
  | 'malformed-repository'
  | 'dirty-repository'
  | 'detached-head'
  | 'active-operation'
  | 'linked-worktree'
  | 'uninitialized-submodule'
  | 'excluded-tracked-path'
  | 'missing-origin-publication'
  | 'missing-passive-object'
  | 'witness-corrupt'
  | 'split-authority'
  | 'sync-conflict'
  | 'external-drift'
  | 'park-failed'
  | 'unpark-failed'
  | 'transition-blocked'
  message: string
  repository?: string
}

export type DevboxGitRoamingStatus = {
  enabled: boolean
  topology: 'working-tree-only'
  authorityScope: 'profile'
  owner: DevboxGitRoamingSide
  epochSequence: number
  epoch: string
  transition: DevboxGitRoamingTransition
  witnesses: 'agree' | 'missing' | 'corrupt' | 'split'
  repositories: number
  manifest: 'verified' | 'blocked' | 'unknown'
  localGit: 'active' | 'parked' | 'mixed' | 'missing'
  remoteGit: 'active' | 'parked' | 'mixed' | 'missing'
  dirtyRepositories: number
  unpublishedRepositories: number
  passiveRefresh: 'fresh' | 'stale' | 'required' | 'unknown'
  passiveRefreshAt?: number
  syncBarrier: 'running' | 'paused' | 'stopped' | 'unknown'
  fence: 'cooperative'
  blockers: readonly DevboxGitRoamingBlocker[]
  warnings: readonly DevboxGitRoamingWarning[]
}

export type DevboxGitRoamingMarker = {
  schemaVersion: 1
  profileId: string
  epochSequence: number
  epoch: string
  owner: DevboxGitRoamingSide
  transitionId: string
  stage: DevboxGitRoamingTransition
  manifestDigest: string
  updatedAt: number
  checksum: string
}

export type DevboxGitRoamingSupervisor = {
  flush(): Promise<void>
  pause(): Promise<void>
  verify(): Promise<{ conflictCount: number; fresh: boolean }>
  resume(): Promise<void>
  status?(): Promise<{ state: 'running' | 'paused' | 'stopped'; conflictCount: number; fresh: boolean }>
}

export type DevboxGitRoamingOptions = {
  profileId: string
  config: DevboxGitRoamingConfig
  local: DevboxGitRoamingHost
  remote: DevboxGitRoamingHost
  stateRoot: string
  defaultOwner?: DevboxGitRoamingSide
  now?: () => number
  refresh?: (side: DevboxGitRoamingSide, repositories: readonly DevboxGitRoamingRepository[]) => Promise<readonly DevboxGitRoamingWarning[] | void>
  marker?: {
    read(): Promise<DevboxGitRoamingMarker | undefined>
    write(marker: DevboxGitRoamingMarker): Promise<void>
  }
  supervisor?: DevboxGitRoamingSupervisor
  failureStage?: DevboxGitRoamingTransition
  holdStage?: DevboxGitRoamingTransition
  holdMs?: number
}

export type DevboxGitRoamingHandoffResult = {
  status: 'committed' | 'replayed' | 'blocked'
  profileId: string
  owner: DevboxGitRoamingSide
  targetOwner: DevboxGitRoamingSide
  epochSequence: number
  epoch: string
  transition: DevboxGitRoamingTransition
  elapsedMs: number
  blockers: readonly DevboxGitRoamingBlocker[]
  warnings: readonly DevboxGitRoamingWarning[]
}

export type DevboxGitRoamingGitResult = DevboxGitRoamingCommandResult & {
  side: DevboxGitRoamingSide
  passive: boolean
}
