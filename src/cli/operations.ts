import { homedir, hostname, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxRunArgs } from '../shared/devbox-ipc'
import type { DevboxManagedBridgeSession } from '../shared/devbox-bridge-capabilities'
import type { DevboxPreflightResult } from '../core/devbox-preflight'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { DevboxProfileConfigStore } from '../core/devbox-profile-config'
import { MutagenCli } from '../sync/mutagen-cli'
import { createProfile, type ProfileCreateInput, type ProfileCreateResult } from './profile-create'
import { addProfileIgnores, listProfileIgnores, removeProfileIgnores, type DevboxProfileIgnoreResult } from './profile-ignore'
import { disableDevboxProfileCredentials, enableDevboxProfileCredentials, showDevboxProfileCredentials, type DevboxProfileCredentialsOptions, type DevboxProfileCredentialsResult } from './profile-credentials'
import { disableDevboxProfilePaste, enableDevboxProfilePaste, showDevboxProfilePaste, type DevboxProfilePasteOptions, type DevboxProfilePasteResult } from './profile-paste'
import { runPreflight } from './preflight'
export { operationKey } from './operation-key'
import { createGitRoamingController, createProfileRuntime, runGitRoamingDryRunInventory, type DevboxProfileRuntime } from './service-runtime'
import { normalizeLaunchResult } from './path-command'
import { resolveMutagenBinary } from '../sync/mutagen-resolver'
import { listDevboxProfiles, setDevboxProfileEnvFile, showDevboxProfileEnvFile, setDevboxProfileShellDir, showDevboxProfileShellDir, setDevboxProfileMaxEntryCount, showDevboxProfileMaxEntryCount, setDevboxProfileWatchPollingInterval, showDevboxProfileWatchPollingInterval, useDevboxProfile, type DevboxProfileEnvFileResult, type DevboxProfileListResult, type DevboxProfileShellDirResult, type DevboxProfileMaxEntryCountResult, type DevboxProfileWatchPollingIntervalResult, type DevboxProfileUseResult } from './profile-preferences'
import { setDevboxProfileProxyCommand, showDevboxProfileProxyCommand, type DevboxProfileProxyCommandResult } from './profile-proxy-command'
import { setDevboxProfileDevice, showDevboxProfileDevice, type DevboxProfileDeviceResult } from './profile-device'
import { bestEffortRemoveDevboxCredentialEnv } from './credential-env-cleanup'
import type { DevboxAuthorityOwner } from '../shared/devbox-types'
import { createDevboxProfileSshTarget, type DevboxProfileSshTarget } from './profile-ssh'
import { attachDevboxShell, killAllDevboxShells, killCurrentDevboxShell, killDevboxShell, killUnattachedDevboxShells, newDevboxShell, resumeDevboxShell, type DevboxShellAttachOptions, type DevboxShellAttachResult, type DevboxShellKillAllResult, type DevboxShellKillResult, type DevboxShellKillUnattachedResult, type DevboxShellListResult } from './shell'
import { createDevboxShellDevicesGroups, devboxDeviceLabelFor, killUnattachedShellSessionsEverywhere, listProfileShellSessions, listShellSessionsEverywhere, type DevboxShellKillDevicesResult, type DevboxShellListAllOptions, type DevboxShellListDeps } from './shell-devices-service'; import { locateDevboxShellTarget, type DevboxShellLocation } from './shell-locate'; import type { DevboxShellDevicesListResult } from './shell-devices'
import type { DevboxShellAttachHistory } from './shell-attach-history'
import { runDevboxServiceShellReconnectAll, runDevboxServiceShellReconnectEverywhere, createDevboxServiceShellHistory } from './shell-service-operations'
import { createDevboxShellLoginRelayFactory } from './shell-login-relay-attach'
import type { DevboxShellReconnectAllResult } from './shell-reconnect-all'
import type { BootstrapProgress, ConnectWorkspaceInput, DevboxHubServiceLike, InitWorkspaceInput, MutagenServiceAction, MutagenSessionAction } from './hub-types'
import { DevboxHubOperations, type DevboxHubOperationsDeps } from './operations-hub'
import { defaultServiceExec } from './mutagen-service'
import { DEVBOX_VERSION } from './version'
import { runSyncNowForService } from './sync-now-deps'; import type { SyncNowOptions } from './sync-now'; import type { SyncNowListener, SyncNowResult } from './sync-now-types'
export { DEVBOX_BLOCKED_OPERATIONS, DevboxBlockedError } from './operations-blocked'
export type { DevboxBlockedOperation } from './operations-blocked'

export const DEVBOX_RETRY_LIMIT = 2
export type { ProfileCreateInput, ProfileCreateResult } from './profile-create'
export const DEVBOX_STATE_ROOT = 'DEVBOX_STATE_ROOT'

export function resolveDevboxStateRoot(env: NodeJS.ProcessEnv = process.env, configuredRoot?: string): string {
  return resolve(configuredRoot || env[DEVBOX_STATE_ROOT]?.trim() || join(homedir(), '.local/state/devbox'))
}

export type DevboxServiceLike = DevboxHubServiceLike & {
  start(profileId: string): Promise<unknown>
  status(profileId: string): unknown
  disable(profileId: string): Promise<unknown>
  launchTerminal(
    profileId: string,
    localPath: string,
    kind: 'terminal' | 'agent',
    command?: readonly string[]
  ): Promise<unknown>
  handoff?(profileId: string, targetOwner: DevboxAuthorityOwner): Promise<unknown>
  git?(profileId: string, path: string, argv: readonly string[]): Promise<unknown>
  shellAttach(profileId: string, target?: string, terminalMarkers?: boolean, reconnect?: boolean, loginRelay?: boolean): Promise<DevboxShellAttachResult>
  shellNew(profileId: string, name?: string, cwdOverride?: string, terminalMarkers?: boolean, reconnect?: boolean, loginRelay?: boolean, run?: string): Promise<DevboxShellAttachResult>
  shellResume(profileId: string, terminalMarkers?: boolean, reconnect?: boolean, loginRelay?: boolean): Promise<DevboxShellAttachResult>
  /** `profileId` undefined covers every device `shell ls` lists. */
  shellReconnectAll(profileId: string | undefined, input: { cwd: string; dryRun: boolean; worktreeOverride?: string; allowHere: boolean }): Promise<DevboxShellReconnectAllResult>
  shellList(profileId: string): Promise<DevboxShellListResult>; shellListAll(options?: DevboxShellListAllOptions): Promise<DevboxShellDevicesListResult>; shellLocate(target: string, preferredProfileId?: string): Promise<DevboxShellLocation>
  shellKill(profileId: string, target: string): Promise<DevboxShellKillResult>; shellKillCurrent(profileId?: string): Promise<DevboxShellKillResult>; shellKillAll(profileId: string): Promise<DevboxShellKillAllResult>; shellKillUnattached(profileId: string): Promise<DevboxShellKillUnattachedResult>; shellKillUnattachedAll(): Promise<DevboxShellKillDevicesResult>
  launchPhi(
    profileId: string,
    localPath: string,
    sessionId: string,
    relayEpoch: string
  ): Promise<unknown>
  runConsistent(profileId: string, spec: DevboxRunArgs['job']): Promise<unknown>
  waitForJob?(profileId: string, jobId: string): Promise<unknown>
  openPort(profileId: string, remotePort: number, allowPublic: boolean, label?: string): Promise<unknown>
  jobStatus(profileId: string, jobId: string): Promise<unknown>
  cancelJob(profileId: string, jobId: string): Promise<unknown>
  tailJobLog(profileId: string, jobId: string, offset?: number, limit?: number): Promise<unknown>
  createProfile(input: ProfileCreateInput): Promise<ProfileCreateResult>
  listProfiles(): DevboxProfileListResult
  useProfile(profileId: string | undefined): DevboxProfileUseResult
  setProfileEnvFile(profileId: string, envFile: string | undefined): Promise<DevboxProfileEnvFileResult>
  showProfileEnvFile(profileId: string): DevboxProfileEnvFileResult
  setProfileShellDir(profileId: string, shellDir: string | undefined): Promise<DevboxProfileShellDirResult>
  showProfileShellDir(profileId: string): DevboxProfileShellDirResult; setProfileProxyCommand(profileId: string, proxyCommand: string | undefined): Promise<DevboxProfileProxyCommandResult>; showProfileProxyCommand(profileId: string): DevboxProfileProxyCommandResult
  setProfileDevice(profileId: string, device: string | undefined): DevboxProfileDeviceResult; showProfileDevice(profileId: string): DevboxProfileDeviceResult
  setProfileMaxEntryCount(profileId: string, maxEntryCount: number | undefined): Promise<DevboxProfileMaxEntryCountResult>
  showProfileMaxEntryCount(profileId: string): DevboxProfileMaxEntryCountResult
  setProfileWatchPollingInterval(profileId: string, watchPollingIntervalSeconds: number | undefined): Promise<DevboxProfileWatchPollingIntervalResult>; showProfileWatchPollingInterval(profileId: string): DevboxProfileWatchPollingIntervalResult
  addProfileIgnores(profileId: string, patterns: readonly string[], rootClass?: string): Promise<DevboxProfileIgnoreResult>
  listProfileIgnores(profileId: string): DevboxProfileIgnoreResult
  removeProfileIgnores(profileId: string, patterns: readonly string[]): Promise<DevboxProfileIgnoreResult>
  enableProfileCredentials(profileId: string, options?: DevboxProfileCredentialsOptions): Promise<DevboxProfileCredentialsResult>
  disableProfileCredentials(profileId: string): Promise<DevboxProfileCredentialsResult>
  showProfileCredentials(profileId: string): DevboxProfileCredentialsResult
  enableProfilePaste(profileId: string, options?: DevboxProfilePasteOptions): Promise<DevboxProfilePasteResult>
  disableProfilePaste(profileId: string): Promise<DevboxProfilePasteResult>
  showProfilePaste(profileId: string): DevboxProfilePasteResult
  preflight(profileId: string): Promise<DevboxPreflightResult>
  /** `devbox sync`: flush every Devbox-owned Mutagen session to every machine now. */
  syncNow?(options: SyncNowOptions, listener: SyncNowListener, signal?: AbortSignal): Promise<SyncNowResult>
  dispose?: () => Promise<void>
}

export type DevboxHubServiceAdapter = Required<DevboxHubServiceLike>

export type DevboxServiceOptions = {
  env?: NodeJS.ProcessEnv
  stateRoot?: string
  /** Test seam; production uses the real hub operation graph below. */
  hubFactory?: (deps: DevboxHubOperationsDeps) => DevboxHubServiceAdapter
}

export class DevboxService implements DevboxServiceLike {
  private readonly stateRoot: string
  private readonly profileRoot: string
  private readonly env: NodeJS.ProcessEnv
  private readonly hubFactory: DevboxServiceOptions['hubFactory']
  private readonly profiles = new Map<string, DevboxProfileRuntime>()
  private shellAttachHistoryInstance: DevboxShellAttachHistory | undefined
  private hubOperations: DevboxHubServiceAdapter | undefined

  constructor(options: DevboxServiceOptions = {}) {
    this.env = options.env ?? process.env
    const configuredRoot = options.stateRoot ?? this.env[DEVBOX_STATE_ROOT]?.trim()
    this.stateRoot = resolveDevboxStateRoot(this.env, configuredRoot)
    this.profileRoot = join(this.stateRoot, 'profiles')
    this.hubFactory = options.hubFactory
  }

  async start(profileId: string): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.start())
  }

  mutagenStatus(profileId: string | undefined, options: { remote: boolean }) { return this.hub.mutagenStatus(profileId, options) }
  mutagenSetup(profileId: string | undefined, options: { remote: boolean; service: boolean }) { return this.hub.mutagenSetup(profileId, options) }
  mutagenServiceAction(action: MutagenServiceAction) { return this.hub.mutagenServiceAction(action) }
  mutagenLogs(lines: number) { return this.hub.mutagenLogs(lines) }
  mutagenSessionAction(profileId: string, action: MutagenSessionAction) { return this.hub.mutagenSessionAction(profileId, action) }
  mutagenSpokes(profileId: string) { return this.hub.mutagenSpokes(profileId) }
  syncNow(options: SyncNowOptions, listener: SyncNowListener, signal?: AbortSignal): Promise<SyncNowResult> { return runSyncNowForService({ stateRoot: this.stateRoot, profileRoot: this.profileRoot, env: this.env, home: this.env.HOME ?? homedir(), startDaemon: () => this.mutagenServiceAction('start') }, options, listener, signal) }
  initWorkspace(input: InitWorkspaceInput, progress?: BootstrapProgress) { return this.hub.initWorkspace(input, progress) }
  connectWorkspace(input: ConnectWorkspaceInput, progress?: BootstrapProgress) { return this.hub.connectWorkspace(input, progress) }

  status(profileId: string): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.statusLive())
  }

  disable(profileId: string): Promise<unknown> { return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.disable()).finally(() => bestEffortRemoveDevboxCredentialEnv(profileId, () => this.sshTarget(profileId).ssh)) }

  async handoff(profileId: string, targetOwner: DevboxAuthorityOwner): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.handoff(targetOwner))
  }

  async git(profileId: string, path: string, argv: readonly string[]): Promise<unknown> {
    const target = this.sshTarget(profileId)
    if (!target.profile.gitRoaming?.enabled) {
      return this.launchTerminal(profileId, path, 'terminal', ['git', ...argv])
    }
    const runtime = await this.runtime(profileId)
    const side = path === target.profile.roots.localRoot || path.startsWith(`${target.profile.roots.localRoot}/`) ? 'local' : path === target.profile.roots.remoteRoot || path.startsWith(`${target.profile.roots.remoteRoot}/`) ? 'remote' : undefined
    if (!side) {throw createDevboxError('operation_conflict', { context: { field: 'git-path' } })}
    return runtime.orchestrator.runGit(side, path, argv)
  }

  async launchTerminal(profileId: string, localPath: string, kind: 'terminal' | 'agent', command?: readonly string[]): Promise<unknown> { await this.start(profileId); const value = await this.withRetry(async () => (await this.runtime(profileId)).orchestrator.launchTerminal(localPath, kind, command)); return normalizeLaunchResult(value) }

  shellAttach(profileId: string, targetName?: string, terminalMarkers = true, reconnect = true, loginRelay = true): Promise<DevboxShellAttachResult> { const target = this.sshTarget(profileId); return attachDevboxShell(profileId, targetName, target.profile.roots.remoteRoot, target.profile.shellDir, target.ssh, target.endpoint, undefined, target.profile.envFile, terminalMarkers, this.shellAttachOptions(reconnect, loginRelay, target)) }

  shellNew(profileId: string, name?: string, cwdOverride?: string, terminalMarkers = true, reconnect = true, loginRelay = true, run?: string): Promise<DevboxShellAttachResult> { const target = this.sshTarget(profileId); return newDevboxShell(profileId, name, target.profile.roots.remoteRoot, target.profile.shellDir, cwdOverride, target.ssh, target.endpoint, undefined, target.profile.envFile, terminalMarkers, { ...this.shellAttachOptions(reconnect, loginRelay, target), ...(run === undefined ? {} : { initialInput: run }) }) }

  shellResume(profileId: string, terminalMarkers = true, reconnect = true, loginRelay = true): Promise<DevboxShellAttachResult> { const target = this.sshTarget(profileId); return resumeDevboxShell(profileId, target.profile.roots.remoteRoot, target.profile.shellDir, target.ssh, target.endpoint, this.shellAttachHistory(), undefined, target.profile.envFile, terminalMarkers, this.shellAttachOptions(reconnect, loginRelay, target)) }

  shellReconnectAll(profileId: string | undefined, input: { cwd: string; dryRun: boolean; worktreeOverride?: string; allowHere: boolean }): Promise<DevboxShellReconnectAllResult> { const common = { history: this.shellAttachHistory(), ...input, env: this.env }; if (profileId === undefined) {return runDevboxServiceShellReconnectEverywhere({ ...common, listAll: () => this.shellListAll() })} const target = this.sshTarget(profileId); return runDevboxServiceShellReconnectAll({ ...common, profileId, device: devboxDeviceLabelFor(this.store().listProfiles(), profileId), runner: target.ssh }) }

  shellList(profileId: string): Promise<DevboxShellListResult> { return listProfileShellSessions(this.shellListDeps(), profileId) }

  shellKill(profileId: string, targetName: string): Promise<DevboxShellKillResult> { const target = this.sshTarget(profileId); return killDevboxShell(profileId, targetName, target.ssh) }

  shellKillCurrent(profileId?: string): Promise<DevboxShellKillResult> { return killCurrentDevboxShell(profileId, undefined, this.env) }

  shellListAll(options?: DevboxShellListAllOptions): Promise<DevboxShellDevicesListResult> { return listShellSessionsEverywhere(this.shellListDeps(), options) } private shellListDeps(): DevboxShellListDeps { return { stateRoot: this.stateRoot, profiles: () => this.store().listProfiles(), defaultProfileId: () => new DevboxProfileConfigStore(join(this.stateRoot, 'config.json')).getDefaultProfile(), target: (id) => this.sshTarget(id) } }
  shellLocate(target: string, preferredProfileId?: string): Promise<DevboxShellLocation> { const profiles = this.store().listProfiles(); return locateDevboxShellTarget({ target, preferredProfileId, profiles, timeoutMs: 10_000, list: (id) => listProfileShellSessions(this.shellListDeps(), id) }) }
  shellKillUnattachedAll(): Promise<DevboxShellKillDevicesResult> { const profiles = this.store().listProfiles(); const groups = createDevboxShellDevicesGroups(profiles); return killUnattachedShellSessionsEverywhere({ groups, kill: (id) => { const target = this.sshTarget(id); return killUnattachedDevboxShells(id, target.ssh) } }) }

  shellKillAll(profileId: string): Promise<DevboxShellKillAllResult> { const target = this.sshTarget(profileId); return killAllDevboxShells(profileId, target.ssh).finally(() => bestEffortRemoveDevboxCredentialEnv(profileId, () => target.ssh)) }

  shellKillUnattached(profileId: string): Promise<DevboxShellKillUnattachedResult> { const target = this.sshTarget(profileId); return killUnattachedDevboxShells(profileId, target.ssh) }

  async launchPhi(
    profileId: string,
    localPath: string,
    sessionId: string,
    relayEpoch: string
  ): Promise<unknown> {
    await this.start(profileId)
    const value = await this.withRetry(async () =>
      (await this.runtime(profileId)).orchestrator.launchPhi(
        localPath,
        sessionId,
        relayEpoch as DevboxManagedBridgeSession['relayEpoch']
      )
    )
    return normalizeLaunchResult(value)
  }

  async runConsistent(profileId: string, spec: DevboxRunArgs['job']): Promise<unknown> {
    await this.start(profileId)
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.runConsistent(spec))
  }

  async waitForJob(profileId: string, jobId: string): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.waitForJob(jobId))
  }

  async openPort(
    profileId: string,
    remotePort: number,
    allowPublic: boolean,
    label?: string
  ): Promise<unknown> {
    await this.start(profileId)
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.openPort(remotePort, allowPublic, label))
  }

  async jobStatus(profileId: string, jobId: string): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.jobStatus(jobId))
  }

  async cancelJob(profileId: string, jobId: string): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.cancelJob(jobId))
  }

  async tailJobLog(profileId: string, jobId: string, offset?: number, limit?: number): Promise<unknown> {
    return this.withRetry(async () => (await this.runtime(profileId)).orchestrator.tailJobLog(jobId, offset, limit))
  }

  async createProfile(input: ProfileCreateInput): Promise<ProfileCreateResult> { return createProfile(input, { profileRoot: this.profileRoot, env: this.env, ...(input.dryRun && input.gitRoaming ? { roamingPreflight: (profile, keys) => runGitRoamingDryRunInventory(profile, keys) } : {}) }) }
  listProfiles(): DevboxProfileListResult { return listDevboxProfiles(this.profileRoot, this.stateRoot, this.env) }
  useProfile(profileId: string | undefined): DevboxProfileUseResult { return useDevboxProfile(this.profileRoot, this.stateRoot, this.env, profileId) }

  async setProfileEnvFile(profileId: string, envFile: string | undefined): Promise<DevboxProfileEnvFileResult> { const value = setDevboxProfileEnvFile(this.profileRoot, this.env, profileId, envFile); if (envFile === undefined) { await bestEffortRemoveDevboxCredentialEnv(profileId, () => this.sshTarget(profileId).ssh) } return value }

  showProfileEnvFile(profileId: string): DevboxProfileEnvFileResult { return showDevboxProfileEnvFile(this.profileRoot, this.env, profileId) }

  async setProfileShellDir(profileId: string, shellDir: string | undefined): Promise<DevboxProfileShellDirResult> { return setDevboxProfileShellDir(this.profileRoot, this.env, profileId, shellDir) }

  showProfileShellDir(profileId: string): DevboxProfileShellDirResult { return showDevboxProfileShellDir(this.profileRoot, this.env, profileId) }

  async setProfileProxyCommand(profileId: string, proxyCommand: string | undefined): Promise<DevboxProfileProxyCommandResult> { return setDevboxProfileProxyCommand(this.profileRoot, this.env, profileId, proxyCommand) }; showProfileProxyCommand(profileId: string): DevboxProfileProxyCommandResult { return showDevboxProfileProxyCommand(this.profileRoot, this.env, profileId) }

  setProfileDevice(profileId: string, device: string | undefined): DevboxProfileDeviceResult { return setDevboxProfileDevice(this.profileRoot, this.env, profileId, device) }
  showProfileDevice(profileId: string): DevboxProfileDeviceResult { return showDevboxProfileDevice(this.profileRoot, this.env, profileId) }

  async setProfileMaxEntryCount(profileId: string, maxEntryCount: number | undefined): Promise<DevboxProfileMaxEntryCountResult> { return setDevboxProfileMaxEntryCount(this.profileRoot, this.env, profileId, maxEntryCount) }

  showProfileMaxEntryCount(profileId: string): DevboxProfileMaxEntryCountResult { return showDevboxProfileMaxEntryCount(this.profileRoot, this.env, profileId) }

  async setProfileWatchPollingInterval(profileId: string, watchPollingIntervalSeconds: number | undefined): Promise<DevboxProfileWatchPollingIntervalResult> { return setDevboxProfileWatchPollingInterval(this.profileRoot, this.env, profileId, watchPollingIntervalSeconds) }

  showProfileWatchPollingInterval(profileId: string): DevboxProfileWatchPollingIntervalResult { return showDevboxProfileWatchPollingInterval(this.profileRoot, this.env, profileId) }

  async addProfileIgnores(profileId: string, patterns: readonly string[], rootClass?: string): Promise<DevboxProfileIgnoreResult> { return addProfileIgnores(this.profileRoot, this.env, profileId, patterns, rootClass) }
  listProfileIgnores(profileId: string): DevboxProfileIgnoreResult { return listProfileIgnores(this.profileRoot, this.env, profileId) }
  async removeProfileIgnores(profileId: string, patterns: readonly string[]): Promise<DevboxProfileIgnoreResult> { return removeProfileIgnores(this.profileRoot, this.env, profileId, patterns) }

  async enableProfileCredentials(profileId: string, options?: DevboxProfileCredentialsOptions): Promise<DevboxProfileCredentialsResult> { return enableDevboxProfileCredentials(this.profileRoot, this.env, profileId, options) }
  disableProfileCredentials(profileId: string): Promise<DevboxProfileCredentialsResult> { return Promise.resolve(disableDevboxProfileCredentials(this.profileRoot, this.env, profileId)) }
  showProfileCredentials(profileId: string): DevboxProfileCredentialsResult { return showDevboxProfileCredentials(this.profileRoot, this.env, profileId) }

  async enableProfilePaste(profileId: string, options?: DevboxProfilePasteOptions): Promise<DevboxProfilePasteResult> { return enableDevboxProfilePaste(this.profileRoot, this.env, profileId, options) }
  disableProfilePaste(profileId: string): Promise<DevboxProfilePasteResult> { return Promise.resolve(disableDevboxProfilePaste(this.profileRoot, this.env, profileId)) }
  showProfilePaste(profileId: string): DevboxProfilePasteResult { return showDevboxProfilePaste(this.profileRoot, this.env, profileId) }

  async preflight(profileId: string): Promise<DevboxPreflightResult> {
    return runPreflight(profileId, { profileRoot: this.profileRoot, env: this.env })
  }

  async dispose(): Promise<void> {
    const runtimes = [...this.profiles.values()]
    this.profiles.clear()
    await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()))
  }

  private get hub(): DevboxHubServiceAdapter {
    return this.hubOperations ??= this.hubFactory?.(this.hubDeps()) ?? new DevboxHubOperations(this.hubDeps())
  }

  private hubDeps(): DevboxHubOperationsDeps {
    return {
      stateRoot: this.stateRoot,
      profileRoot: this.profileRoot,
      env: this.env,
      home: this.env.HOME ?? homedir(),
      platform: process.platform,
      devboxVersion: DEVBOX_VERSION,
      hostname: hostname(),
      username: userInfo().username,
      loadProfile: (profileId) => {
        const loaded = this.store().loadProfile(profileId)
        if (loaded.status !== 'loaded') { throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } }) }
        return loaded.profile
      },
      sshTarget: (profileId) => this.sshTarget(profileId),
      createMutagen: (profileId) => this.createMutagen(profileId),
      pair: (profileId) => this.start(profileId),
      preflight: (profileId) => this.preflight(profileId),
      createProfile: (input, options) => createProfile(input, { profileRoot: this.profileRoot, env: this.env, ...(options?.keyscan ? { keyscan: options.keyscan } : {}) }),
      useProfile: (id) => this.useProfile(id),
      configuredDefaultProfile: () => new DevboxProfileConfigStore(join(this.stateRoot, 'config.json')).getDefaultProfile(),
      setProfileEnvFile: (id, path) => this.setProfileEnvFile(id, path),
      setProfileShellDir: (id, path) => this.setProfileShellDir(id, path), exec: defaultServiceExec
    }
  }

  private shellAttachHistory(): DevboxShellAttachHistory { return this.shellAttachHistoryInstance ??= createDevboxServiceShellHistory(this.stateRoot, this.env) }

  private shellAttachOptions(reconnect: boolean, loginRelay: boolean, target: DevboxProfileSshTarget): DevboxShellAttachOptions { return { reconnect, history: this.shellAttachHistory(), loginRelay: createDevboxShellLoginRelayFactory({ env: this.env, stateRoot: this.stateRoot, disabled: !loginRelay }), deviceLabel: devboxDeviceLabelFor(this.store().listProfiles(), target.profile.id), local: target.local, interactive: target.interactive } }

  private async runtime(profileId: string): Promise<DevboxProfileRuntime> {
    const existing = this.profiles.get(profileId)
    if (existing) { return existing }
    const profileStore = this.store()
    const target = this.sshTarget(profileId)
    const mutagen = await this.createMutagen(profileId)
    const runtime = await createProfileRuntime({ profileId, stateRoot: this.stateRoot, profileRoot: this.profileRoot, env: this.env, profileStore, target, mutagen, createGitRoaming: (profile, ssh) => createGitRoamingController(profile, ssh, this.stateRoot) })
    this.profiles.set(profileId, runtime)
    return runtime
  }

  private sshTarget(profileId: string): DevboxProfileSshTarget {
    return createDevboxProfileSshTarget(profileId, this.profileRoot, this.store())
  }

  private store(): DevboxProfileStore {
    return new DevboxProfileStore({ rootDir: this.profileRoot, env: this.env })
  }

  private async createMutagen(profileId: string): Promise<MutagenCli> {
    const binaryPath = await resolveMutagenBinary({ env: this.env })
    return new MutagenCli({ profileId, binaryPath, dataDirectory: join(this.stateRoot, 'mutagen'), appDataRoot: this.stateRoot, environment: this.env })
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (attempt >= DEVBOX_RETRY_LIMIT || !(isDevboxError(error) ? error.retryable : false)) {
          throw error
        }
      }
    }
  }
}

function isDevboxError(error: unknown): error is DevboxError {
  return typeof error === 'object' && error !== null && 'code' in error && 'retryable' in error
}

