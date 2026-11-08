import { homedir, hostname as systemHostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveMutagenBinary } from '../sync/mutagen-resolver'
import { MutagenCli } from '../sync/mutagen-cli'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxPreflightResult } from '../core/devbox-preflight'
import type { DevboxHubServiceLike, MutagenDaemonProbe, MutagenSetupServiceAction, MutagenServiceAction, MutagenServiceActionResult, MutagenSetupResult, MutagenSessionAction, MutagenSessionActionResult, MutagenStatusResult, MutagenLogsResult, MutagenSpokesResult, WorkspaceBootstrapResult, InitWorkspaceInput, ConnectWorkspaceInput, BootstrapProgress } from './hub-types'
import type { ProfileCreateInput, ProfileCreateResult } from './profile-create'
import type { DevboxProfileSshTarget } from './profile-ssh'
import { createMutagenDaemonService, defaultServiceExec, detectLegacyWrapper, mutagenServicePaths, type MutagenDaemonService, type ServiceExec } from './mutagen-service'
import { probeMutagenDaemon } from './mutagen-daemon-probe'
import { assembleMutagenStatus } from './mutagen-status'
import { hubIdForRoot, loadOrCreateSpokeIdentity, recordSpokeRoot } from './spoke-identity'
import { registerHubAndSpoke, readHub, type HubRegistryTarget, type SpokeFacts } from './hub-registry'
import { runWorkspaceBootstrap, type WorkspaceBootstrapDeps } from './workspace-bootstrap'
import type { ScannedKey } from './profile-create'
import { acquireSyncLock, syncLockPath, type SyncLockHolder } from './sync-now-lock'


export type DevboxHubOperationsDeps = {
  stateRoot: string
  profileRoot: string
  env: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  devboxVersion: string
  hostname?: string
  username?: string
  daemonService?: MutagenDaemonService
  exec?: ServiceExec
  resolveBinary?: () => Promise<string>
  sleep?: (ms: number) => Promise<void>
  probe?: typeof probeMutagenDaemon
  loadProfile: (profileId: string) => DevboxProfileV1
  sshTarget: (profileId: string) => DevboxProfileSshTarget
  createMutagen: (profileId: string) => Promise<MutagenCli>
  pair: (profileId: string) => Promise<unknown>
  preflight: (profileId: string) => Promise<DevboxPreflightResult>
  createProfile: (input: ProfileCreateInput, options?: { keyscan?: (host: string, port: number) => Promise<readonly ScannedKey[]> }) => Promise<ProfileCreateResult>
  useProfile: (id: string) => unknown
  configuredDefaultProfile: () => string | undefined
  setProfileEnvFile: (id: string, path: string) => Promise<unknown>
  setProfileShellDir: (id: string, path: string) => Promise<unknown>
  readHub?: typeof readHub
  registerHubAndSpoke?: typeof registerHubAndSpoke
  /** `mutagen stop|restart` is waiting for a running `db sync` (default: a stderr note). */
  onSyncLockWait?: (action: MutagenServiceAction, holder: SyncLockHolder) => void
}

export class DevboxHubOperations implements Required<DevboxHubServiceLike> {
  private readonly deps: DevboxHubOperationsDeps
  private readonly daemonService: MutagenDaemonService
  private readonly home: string
  private readonly platform: NodeJS.Platform

  constructor(deps: DevboxHubOperationsDeps) {
    this.deps = { ...deps, exec: deps.exec ?? defaultServiceExec }
    this.home = deps.home ?? deps.env.HOME ?? homedir()
    this.platform = deps.platform ?? process.platform
    this.daemonService = deps.daemonService ?? createMutagenDaemonService({ stateRoot: deps.stateRoot, home: this.home, platform: this.platform, env: deps.env, devboxVersion: deps.devboxVersion, exec: this.deps.exec })
  }

  mutagenStatus(profileId: string | undefined, options: { remote: boolean }): Promise<MutagenStatusResult> {
    return assembleMutagenStatus({ ...this.deps, home: this.home, platform: this.platform, daemonService: this.daemonService, ...(this.deps.probe ? { probe: this.deps.probe } : {}) }, profileId, options)
  }

  async mutagenSetup(profileId: string | undefined, options: { remote: boolean; service: boolean }): Promise<MutagenSetupResult> {
    const dataDirectory = join(this.deps.stateRoot, 'mutagen')
    let binaryPath: string | null = null
    let service = await this.daemonService.describe()
    let setupAction: MutagenSetupServiceAction = 'skipped'
    const hints: string[] = []
    if (options.service) {
      binaryPath = await (this.deps.resolveBinary ?? (() => resolveMutagenBinary({ env: this.deps.env, home: this.home, platform: this.platform })))()
      const installed = await this.daemonService.install({ binaryPath, dataDirectory })
      service = installed.state
      setupAction = installed.action
      if (installed.action !== 'unsupported') {
        let daemon = await this.probe(binaryPath, service.pid)
        if (daemon.running && daemon.origin !== 'service') {
          try { await this.cli('devbox', binaryPath).daemonStop() } catch { /* handoff continues with restart */ }
          try {
            service = await this.daemonService.restart()
            daemon = await this.waitForDaemon(binaryPath, service.pid, 45_000, (value) => value.running && value.origin === 'service')
          } catch {
            daemon = await this.probe(binaryPath, service.pid)
          }
          if (!(daemon.running && daemon.origin === 'service')) {
            await this.cli('devbox', binaryPath).daemonStart()
            hints.push('The service did not take ownership; Mutagen was started on demand.')
          }
        }
      }
    }
    let daemon = await this.probe(binaryPath, service.pid)
    const paths = mutagenServicePaths({ stateRoot: this.deps.stateRoot, home: this.home, platform: this.platform, env: this.deps.env })
    const legacyWrapper = detectLegacyWrapper(this.home, paths.wrapperPath)
    if (legacyWrapper) {hints.push(`Legacy Mutagen wrapper remains at ${legacyWrapper}; it is no longer used.`)}
    if (service.platform === 'linux' && service.detail) {hints.push(service.detail)}
    let hub = null
    if (profileId) {
      const profile = this.deps.loadProfile(profileId)
      recordSpokeRoot(this.deps.stateRoot, profile.roots.localRoot)
      if (options.remote) {
        const target = this.deps.sshTarget(profileId)
        const registry = this.registry(target)
        const facts = this.facts(profileId, profile)
        try {
          hub = await (this.deps.registerHubAndSpoke ?? registerHubAndSpoke)(registry, facts)
          if (!hub.reachable) {hints.push(hub.detail ?? 'Unable to reach the hub.')}
        } catch (error) {
          hub = await readHubSafely(registry, facts.spokeId, this.deps.readHub)
          hints.push(errorMessage(error))
        }
      }
    }
    daemon = await this.probe(binaryPath, service.pid)
    return { profileId: profileId ?? null, service: { ...service, action: setupAction }, daemon, hub, legacyWrapper, hints }
  }

  /** stop/restart take the `db sync` run lock so a daemon restart never lands mid-sync. */
  async mutagenServiceAction(action: MutagenServiceAction): Promise<MutagenServiceActionResult> {
    if (action !== 'stop' && action !== 'restart') {return this.serviceAction(action)}
    const lock = await acquireSyncLock({ path: syncLockPath(this.deps.stateRoot), command: `db mutagen ${action}`, onWait: (holder) => (this.deps.onSyncLockWait ?? noteSyncLockWait)(action, holder) })
    try { return await this.serviceAction(action) } finally { lock?.release() }
  }

  private async serviceAction(action: MutagenServiceAction): Promise<MutagenServiceActionResult> {
    const startedAt = Date.now()
    const binaryPath = action === 'delete' ? null : await (this.deps.resolveBinary ?? (() => resolveMutagenBinary({ env: this.deps.env, home: this.home, platform: this.platform })))()
    const current = await this.daemonService.describe()
    const cli = (): MutagenCli => {
      if (binaryPath === null) {throw new Error('Mutagen binary is unavailable.')}
      return this.cli('devbox', binaryPath)
    }
    let service = current
    const via: MutagenServiceActionResult['via'] = current.installed ? current.manager : 'mutagen-cli'
    if (action === 'start') {
      if (current.installed) {
        service = await this.daemonService.start()
        await this.waitForDaemon(binaryPath, service.pid, 10_000, (value) => value.running)
      } else {await cli().daemonStart()}
    } else if (action === 'stop') {
      const beforeStop = await this.probe(binaryPath, current.pid)
      if (beforeStop.running) {
        await cli().daemonStop()
      } else if (!current.installed) {
        await cli().daemonStop()
      }
      if (current.installed) {
        service = await this.daemonService.stop()
      }
      await this.waitForDaemon(binaryPath, current.pid, 10_000, (value) => !value.running)
    } else if (action === 'restart') {
      const beforeRestart = await this.probe(binaryPath, current.pid)
      if (beforeRestart.running) {
        await cli().daemonStop()
      }
      if (current.installed) {
        service = await this.daemonService.restart()
      } else {
        await cli().daemonStart()
      }
      await this.waitForDaemon(binaryPath, service.pid, 45_000, (value) => value.running && (!current.installed || value.origin === 'service'))
    } else {
      service = await this.daemonService.uninstall()
    }
    const daemon = await this.probe(binaryPath, service.pid)
    const detail = action === 'delete'
      ? 'Keepalive service removed; sessions untouched. Sync-touching commands (status, sync, pair) start the daemon on demand; `devbox mutagen status` never does.'
      : action === 'restart' ? `daemon restart completed in ${Date.now() - startedAt}ms` : undefined
    return { action, via, service, daemon, ...(detail ? { detail } : {}) }
  }

  mutagenLogs(lines: number): Promise<MutagenLogsResult> { return this.daemonService.readLog(lines) }

  async mutagenSessionAction(profileId: string, action: MutagenSessionAction): Promise<MutagenSessionActionResult> {
    const cli = await this.deps.createMutagen(profileId)
    const sessions = await cli.listSessions()
    const results: MutagenSessionActionResult['sessions'][number][] = []
    for (const session of sessions) {
      try { await cli[action](session.identifier); results.push({ identifier: session.identifier, name: session.name, ok: true }) }
      catch (error) { results.push({ identifier: session.identifier, name: session.name, ok: false, error: errorMessage(error) }) }
    }
    return { profileId, action, sessions: results }
  }

  async mutagenSpokes(profileId: string): Promise<MutagenSpokesResult> {
    this.deps.loadProfile(profileId)
    const identity = loadOrCreateSpokeIdentity(this.deps.stateRoot)
    const reader = this.deps.readHub ?? readHub
    return { profileId, hub: await reader(this.registry(this.deps.sshTarget(profileId)), identity.spokeId) }
  }

  initWorkspace(input: InitWorkspaceInput, progress?: BootstrapProgress): Promise<WorkspaceBootstrapResult> { return this.workspace('init', input, progress) }
  connectWorkspace(input: ConnectWorkspaceInput, progress?: BootstrapProgress): Promise<WorkspaceBootstrapResult> { return this.workspace('connect', input, progress) }

  private workspace(mode: 'init' | 'connect', input: InitWorkspaceInput | ConnectWorkspaceInput, progress?: BootstrapProgress): Promise<WorkspaceBootstrapResult> {
    const deps: WorkspaceBootstrapDeps = { ...this.deps, home: this.home, hostname: this.deps.hostname ?? systemHostname(), username: this.deps.username ?? userInfo().username, sshTarget: this.deps.sshTarget, mutagenSetup: (profileId, options) => this.mutagenSetup(profileId, options) }
    return runWorkspaceBootstrap(deps, mode, input, progress)
  }

  private registry(target: DevboxProfileSshTarget): HubRegistryTarget { return { ssh: target.ssh, host: target.endpoint.host, port: target.endpoint.port, user: target.endpoint.username, remoteRoot: target.profile.roots.remoteRoot } }
  private facts(profileId: string, profile: DevboxProfileV1): SpokeFacts { const identity = loadOrCreateSpokeIdentity(this.deps.stateRoot); return { spokeId: identity.spokeId, hostname: this.deps.hostname ?? systemHostname(), platform: this.platform, username: this.deps.username ?? this.deps.env.USER ?? userInfo().username, localRoot: profile.roots.localRoot, profileId, devboxVersion: this.deps.devboxVersion } }
  private cli(profileId: string, binaryPath: string): MutagenCli { return new MutagenCli({ profileId, binaryPath, dataDirectory: join(this.deps.stateRoot, 'mutagen'), appDataRoot: this.deps.stateRoot, environment: this.deps.env, commandRunner: async (command, args, options) => this.deps.exec!(command, args, options) }) }
  private probe(binaryPath: string | null, servicePid: number | null): Promise<MutagenDaemonProbe> { return (this.deps.probe ?? probeMutagenDaemon)({ dataDirectory: join(this.deps.stateRoot, 'mutagen'), binaryPath, platform: this.platform, exec: this.deps.exec, servicePid }) }
  private async waitForDaemon(binaryPath: string | null, servicePid: number | null, timeout: number, predicate: (probe: MutagenDaemonProbe) => boolean): Promise<MutagenDaemonProbe> { const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))); let result = await this.probe(binaryPath, servicePid); for (let elapsed = 0; elapsed < timeout && !predicate(result); elapsed += 1000) { await sleep(1000); result = await this.probe(binaryPath, servicePid) } return result }
}

async function readHubSafely(target: HubRegistryTarget, spokeId: string, reader: typeof readHub = readHub): Promise<ReturnType<typeof readHub>> {
  try { return await reader(target, spokeId) }
  catch (error) {
    return {
      reachable: false,
      hubId: hubIdForRoot(target.remoteRoot),
      root: target.remoteRoot,
      host: target.host,
      port: target.port,
      user: target.user,
      registered: false,
      record: null,
      spokes: [],
      thisSpokeId: spokeId,
      liveAgentCount: null,
      rootState: 'unknown',
      isSpokeRoot: false,
      detail: errorMessage(error)
    }
  }
}

function noteSyncLockWait(action: MutagenServiceAction, holder: SyncLockHolder): void {
  const what = holder.command === undefined || holder.command === 'db sync' ? 'the running sync' : holder.command
  process.stderr.write(`devbox: waiting for ${what} (pid ${holder.pid}) to finish before the Mutagen daemon ${action}...\n`)
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : String(error) }
