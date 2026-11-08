import { dirname, isAbsolute, join } from 'node:path'
import {
  DEVBOX_MUTAGEN_MODES,
  DEVBOX_SYNC_PROFILE_LABEL,
  DEVBOX_SYNC_ROOT_CLASS_LABEL,
  DEVBOX_SYNC_SESSION_LABEL,
  type DevboxSyncCreateRequest
} from './devbox-sync-backend'
import {
  buildMutagenActionArgs,
  buildMutagenCreateArgs,
  buildMutagenDaemonArgs,
  buildMutagenMonitorArgs,
  buildMutagenStateArgs,
  createMutagenCommandFailure,
  createMutagenOperationConflict,
  defaultMutagenCommandRunner,
  requireAbsoluteAppPath,
  validateMutagenBinaryPath
} from './mutagen-cli-argv'
import {
  isAppOwnedMutagenSession,
  parseMutagenMonitorOutput,
  parseMutagenSessionArray
} from './mutagen-cli-output'
import { upgradeMutagen } from './mutagen-cli-upgrade'
import type {
  MutagenCliOptions,
  MutagenCommandResult,
  MutagenCommandRunner,
  MutagenCreateSessionOptions,
  MutagenSessionRecord,
  MutagenUpgradeOptions
} from './mutagen-cli-types'

export {
  MUTAGEN_DEFAULT_MAX_ENTRY_COUNT,
  MUTAGEN_JSON_TEMPLATE,
  MUTAGEN_POLLING_INTERVAL_SECONDS
} from './mutagen-cli-types'
export type {
  MutagenCliOptions,
  MutagenCommandResult,
  MutagenCommandRunner,
  MutagenConflictRecord,
  MutagenConflictSide,
  MutagenCreateSessionOptions,
  MutagenSessionRecord,
  MutagenUpgradeOptions,
  MutagenWatchState
} from './mutagen-cli-types'

export { parseMutagenMonitorOutput }

export class MutagenCli {
  private readonly dataDirectory: string
  private readonly profileId: string
  private readonly commandRunner: MutagenCommandRunner
  private readonly environment: NodeJS.ProcessEnv
  private binaryPath: string

  constructor(options: MutagenCliOptions) {
    const appDataRoot = options.appDataRoot ?? dirname(options.dataDirectory)
    this.dataDirectory = requireAbsoluteAppPath(
      options.dataDirectory,
      appDataRoot,
      'mutagen-data-directory'
    )
    // Unix domain sockets cap sun_path at ~104 bytes on macOS (108 Linux).
    // The daemon socket lives under <dataDirectory>/daemon/; a too-long data
    // directory produces mysterious "connection timed out" daemon failures,
    // so fail closed with a clear field instead. Only enforced when real
    // Mutagen processes will run (no injected command runner).
    if (!options.commandRunner && join(this.dataDirectory, 'daemon', 'daemon.sock').length > 100) {
      throw createMutagenOperationConflict(options.profileId, 'mutagen-data-directory-socket-path')
    }
    this.binaryPath = options.binaryPath
    this.profileId = options.profileId
    this.commandRunner = options.commandRunner ?? defaultMutagenCommandRunner
    if (options.sshPath && !isAbsolute(options.sshPath)) {
      throw createMutagenOperationConflict(options.profileId, 'mutagen-ssh-path')
    }
    // The child environment is deliberately scrubbed, but Mutagen needs a
    // handful of platform basics: on macOS the daemon start/stop "system
    // mechanism" (launchd) probe fails with "$HOME is not defined" without
    // HOME. MUTAGEN_DATA_DIRECTORY still pins all state app-privately.
    this.environment = {
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      ...options.environment,
      MUTAGEN_DATA_DIRECTORY: this.dataDirectory,
      ...(options.sshPath ? { MUTAGEN_SSH_PATH: options.sshPath } : {})
    }
    validateMutagenBinaryPath(options.binaryPath, options.profileId)
  }

  get currentBinaryPath(): string {
    return this.binaryPath
  }

  get appPrivateDataDirectory(): string {
    return this.dataDirectory
  }

  async createSession(
    request: DevboxSyncCreateRequest,
    options: MutagenCreateSessionOptions,
    signal?: AbortSignal
  ): Promise<MutagenSessionRecord> {
    if (
      request.profileId !== this.profileId ||
      !DEVBOX_MUTAGEN_MODES.has(request.mode) ||
      !options.remoteEndpoint ||
      options.remoteEndpoint.startsWith('-') ||
      !options.name ||
      options.labels[DEVBOX_SYNC_PROFILE_LABEL] !== this.profileId ||
      options.labels[DEVBOX_SYNC_SESSION_LABEL] !== request.sessionId ||
      options.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] !== request.rootClassId
    ) {
      throw createMutagenOperationConflict(this.profileId, 'mutagen-create-policy')
    }
    await this.run(buildMutagenCreateArgs(request, options), signal)
    const sessions = await this.listSessions(signal)
    const matches = sessions.filter(
      (session) =>
        session.labels[DEVBOX_SYNC_SESSION_LABEL] === request.sessionId &&
        session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] === request.rootClassId
    )
    if (matches.length !== 1) {
      throw createMutagenOperationConflict(
        this.profileId,
        'created-session-not-uniquely-discoverable'
      )
    }
    return matches[0]
  }

  async listSessions(signal?: AbortSignal): Promise<readonly MutagenSessionRecord[]> {
    const sessions = await this.readState(
      ['sync', 'list', `--label-selector=${DEVBOX_SYNC_PROFILE_LABEL}=${this.profileId}`],
      signal
    )
    return sessions.filter((session) => isAppOwnedMutagenSession(session, this.profileId))
  }

  async monitor(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<readonly (readonly MutagenSessionRecord[])[]> {
    this.requireSelector(sessionId)
    const result = await this.run(buildMutagenMonitorArgs(sessionId), signal)
    try {
      return parseMutagenMonitorOutput(result.stdout)
    } catch {
      throw createMutagenOperationConflict(this.profileId, 'malformed-monitor-output')
    }
  }

  async pause(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.runAction('pause', sessionId, signal)
  }

  async resume(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.runAction('resume', sessionId, signal)
  }

  async flush(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.runAction('flush', sessionId, signal)
  }

  async terminate(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.runAction('terminate', sessionId, signal)
  }

  async daemonStart(signal?: AbortSignal): Promise<void> {
    await this.run(buildMutagenDaemonArgs('start'), signal)
  }

  async daemonStop(signal?: AbortSignal): Promise<void> {
    await this.run(buildMutagenDaemonArgs('stop'), signal)
  }

  async upgrade(options: MutagenUpgradeOptions, signal?: AbortSignal): Promise<void> {
    await upgradeMutagen(this, this.profileId, options, signal, (binaryPath) => {
      this.binaryPath = binaryPath
    })
  }

  private async runAction(
    action: 'pause' | 'resume' | 'flush' | 'terminate',
    sessionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.requireSelector(sessionId)
    await this.run(buildMutagenActionArgs(action, sessionId), signal)
  }

  private async readState(
    prefix: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly MutagenSessionRecord[]> {
    const result = await this.run(buildMutagenStateArgs(prefix), signal)
    try {
      return parseMutagenSessionArray(result.stdout)
    } catch {
      throw createMutagenOperationConflict(this.profileId, 'malformed-state-output')
    }
  }

  private requireSelector(sessionId: string): void {
    if (!sessionId || sessionId.startsWith('-')) {
      throw createMutagenOperationConflict(this.profileId, 'session-selector')
    }
  }

  private async run(args: readonly string[], signal?: AbortSignal): Promise<MutagenCommandResult> {
    let result: MutagenCommandResult
    try {
      result = await this.commandRunner(this.binaryPath, args, {
        env: { ...this.environment },
        signal
      })
    } catch (error) {
      throw createMutagenCommandFailure(
        this.profileId,
        error instanceof Error ? error.message : String(error)
      )
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim()
      throw createMutagenCommandFailure(
        this.profileId,
        detail || `Mutagen exited with status ${result.exitCode}.`
      )
    }
    return result
  }
}
