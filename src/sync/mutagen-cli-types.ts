import type { MutagenReleasePlatform } from './mutagen-release-pins'
import type { DevboxSyncExclusionPolicy } from './devbox-sync-backend'
import {
  DEVBOX_DEFAULT_MAX_ENTRY_COUNT,
  DEVBOX_DEFAULT_WATCH_POLLING_INTERVAL_SECONDS
} from '../shared/devbox-types'
import type { DevboxToolchainLockV1 } from '../shared/devbox-toolchain-lock'
import type { MutagenCli } from './mutagen-cli'

export const MUTAGEN_JSON_TEMPLATE = '{{json .}}' as const
export const MUTAGEN_POLLING_INTERVAL_SECONDS = DEVBOX_DEFAULT_WATCH_POLLING_INTERVAL_SECONDS
export const MUTAGEN_DEFAULT_MAX_ENTRY_COUNT = DEVBOX_DEFAULT_MAX_ENTRY_COUNT
// Devbox deliberately passes no default `--max-staging-file-size`, leaving Mutagen's
// own default (unlimited). Mutagen (v0.18.1, staging/store.Storage.Write) does not
// skip a file that exceeds the cap: it streams it, aborts the staging write at the
// limit, then fails the transition ("no such file or directory") and retries the
// full transfer on every cycle. With the former 100 MB default an `project`-sized
// workspace re-sent ~15 GB per cycle forever and every cycle stretched to minutes.
// Large artifacts must be excluded with ignore patterns instead; an explicit
// `maxStagingFileSize` is still honored when a caller opts in.

export type MutagenCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type MutagenCommandRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal }
) => Promise<MutagenCommandResult>

export type MutagenConflictSide = {
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'other'
  hash: string | null
  mode?: number
  size?: number
}

export type MutagenConflictRecord = {
  path: string
  alpha: MutagenConflictSide
  beta: MutagenConflictSide
}

export type MutagenWatchState = {
  mode: string
  pollingInterval: number | null
  native: boolean | null
}

export type MutagenSessionRecord = {
  identifier: string
  name: string | null
  labels: Readonly<Record<string, string>>
  paused: boolean
  status: string
  successfulCycles: number
  conflicts: readonly MutagenConflictRecord[]
  /** Mutagen exposes the most recent scan/transfer failure on list/monitor. */
  lastError?: string | null
  /** Normalized problem text; the array length is the authoritative problem count. */
  problems?: readonly string[]
  watch: MutagenWatchState
  lastChangeAt: number | null
  lastSynchronizedAt: number | null
}

export type MutagenCreateSessionOptions = {
  remoteEndpoint: string
  name: string
  labels: Readonly<Record<string, string>>
  excludes?: readonly string[]
  exclusionPolicy?: DevboxSyncExclusionPolicy
  maxEntryCount?: number
  maxStagingFileSize?: string
  watchMode?: 'portable' | 'force-poll' | 'no-watch'
  pollingIntervalSeconds?: number
}

export type MutagenCliOptions = {
  binaryPath: string
  dataDirectory: string
  /** The parent is the app-owned namespace; it prevents ~/.mutagen adoption. */
  appDataRoot?: string
  profileId: string
  commandRunner?: MutagenCommandRunner
  environment?: NodeJS.ProcessEnv
  sshPath?: string
}

export type MutagenUpgradeOptions = {
  newBinaryPath: string
  lock: DevboxToolchainLockV1
  platform: MutagenReleasePlatform
  snapshotDataDirectory: () => Promise<unknown>
  restoreDataDirectory: (snapshot: unknown) => Promise<void>
  installBinary?: (binaryPath: string) => Promise<void>
  restoreBinary?: () => Promise<void>
  recreateAndVerify: (cli: MutagenCli) => Promise<void>
}
