import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { commandExecFileAsync } from '../shared/exec'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import { createSystemSshRunner, spawnSystemSshInteractive } from '../ssh/system-ssh-runner'
import { shellEscape } from '../ssh/shell-escape'
import { stopInteractiveChild } from './devbox-child-lifecycle'
import { createStandaloneSyncStores } from './devbox-standalone-sync-stores'
import type {
  DevboxGenerationAdapter,
  DevboxPhiAdapter,
  DevboxPortAdapter,
  DevboxProjectHostAdapter,
  DevboxTerminalAdapter
} from './devbox-orchestrator-types'
import type { DevboxProfileStore } from './devbox-profile-store'
import { DevboxJobLogStore } from './devbox-job-logs'
import { DevboxJobSupervisor } from './devbox-job-supervisor'
import { DevboxJobTransport } from './devbox-job-transport'
import { DevboxGenerationAdapter as DevboxGenerationAdapterImpl } from './devbox-generation-adapter'
import {
  DevboxPortsAdapter,
  type DevboxPortForwarder
} from './devbox-ports-adapter'
import { DEVBOX_BRIDGE_CAPABILITY_ENV } from './devbox-bridge-dispatch'
import type { DevboxGenerationSync } from '../sync/devbox-workspace-generation-manager'
import type {
  DevboxSyncBackend,
  DevboxSyncCreateRequest
} from '../sync/devbox-sync-backend'
import { MutagenSyncBackend } from '../sync/mutagen-sync-backend'
import { RsyncSyncBackend } from '../sync/rsync-sync-backend'
import { devboxSyncRequests } from './devbox-orchestrator-actions'
import type { MutagenCli } from '../sync/mutagen-cli'
import { proxySshOptions } from '../ssh/ssh-proxy'

export type DevboxSshRunnerFactory = (
  endpoint: SshEndpoint,
  profile: DevboxProfileV1 | null
) => DevboxSshRunner

export type DevboxStandaloneAdapters = {
  projectHost: DevboxProjectHostAdapter
  terminal: DevboxTerminalAdapter
  phi: DevboxPhiAdapter
  jobs: DevboxJobSupervisor
  generation: DevboxGenerationAdapter
  ports: DevboxPortAdapter
  syncRequests: (profile: DevboxProfileV1) => DevboxSyncCreateRequest[]
  mutagenBackendFactory: (request: DevboxSyncCreateRequest) => Promise<DevboxSyncBackend>
  rsyncBackendFactory: (request: DevboxSyncCreateRequest) => Promise<DevboxSyncBackend>
  dispose?: () => Promise<void>
}

export type DevboxStandaloneAdapterOptions = {
  profileId: string
  profileStore: DevboxProfileStore
  stateRoot?: string
  env?: NodeJS.ProcessEnv
  /** A runner or a factory. Factories receive the resolved endpoint and profile. */
  sshRunner?: DevboxSshRunner | DevboxSshRunnerFactory
  sshRunnerFactory?: DevboxSshRunnerFactory
  /** Compatibility injection used by the standalone CLI. */
  ssh?: DevboxSshRunner
  /** Mutagen client supplied by the CLI when native sync is available. */
  mutagen?: MutagenCli
  /** Optional endpoint for an embedding application that has not loaded a profile yet. */
  sshEndpoint?: SshEndpoint
  endpoint?: SshEndpoint
  /** Injected seam for tests; otherwise the system OpenSSH port forwarder is used. */
  portForwarder?: DevboxPortForwarder
  /** Reuse the orchestrator's supervisor for generation leases when available. */
  syncSupervisor?: DevboxGenerationSync | (() => DevboxGenerationSync)
}

/**
 * Compose the standalone adapter set consumed by DevboxOrchestrator. This is
 * intentionally free of Electron or host-runtime services: all remote work
 * goes through system OpenSSH and all local state is below stateRoot.
 */
export function createStandaloneDevboxAdapters(
  options: DevboxStandaloneAdapterOptions
): DevboxStandaloneAdapters {
  const environment = options.env ?? process.env
  const stateRoot =
    options.stateRoot ??
    environment.DEVBOX_STATE_ROOT ??
    join(homedir(), '.local', 'state', 'devbox')
  const loaded = options.profileStore.loadProfile(options.profileId)
  const profile = loaded.status === 'loaded' ? loaded.profile : null
  const endpoint = options.sshEndpoint ?? options.endpoint ?? (profile ? endpointFor(profile) : null)
  const runner = resolveRunner(options, endpoint, profile)

  const projectHost: DevboxProjectHostAdapter = {
    async ensure({ profile: projectProfile, remotePath }) {
      const digest = createHash('sha256')
        .update(`${projectProfile.id}\0${remotePath}`)
        .digest('hex')
        .slice(0, 16)
      const executionHostId = `ssh:${projectProfile.sshTarget.targetId}`
      return {
        setupId: `devbox-${projectProfile.id}-${digest}`,
        executionHostId
      }
    }
  }

  const logs = new DevboxJobLogStore({
    rootDir: join(stateRoot, 'profiles', options.profileId, 'jobs', 'logs')
  })
  const jobs = new DevboxJobSupervisor({
    transport: new DevboxJobTransport({
      runner,
      profileId: options.profileId,
      logs,
      envFilePathForRun: () => {
        const latest = options.profileStore.loadProfile(options.profileId)
        return latest.status === 'loaded' ? latest.profile.envFile : undefined
      }
    }),
    logs
  })
  const generation = new DevboxGenerationAdapterImpl({
    profileId: options.profileId,
    profileStore: options.profileStore,
    generationsRoot: join(stateRoot, 'generations'),
    env: environment,
    runner,
    syncSupervisor: options.syncSupervisor
  })
  const ports = new DevboxPortsAdapter({
    runner,
    endpoint: endpoint ?? undefined,
    forwarder: options.portForwarder
  })
  const syncStores = createStandaloneSyncStores()
  const mutagenBackendFactory = async (request: DevboxSyncCreateRequest): Promise<DevboxSyncBackend> => {
    if (!options.mutagen) {
      throw createDevboxError('operation_conflict', { context: { field: 'mutagen-binary' } })
    }
    return new MutagenSyncBackend({
      profileId: options.profileId,
      cli: options.mutagen,
      sessionStore: syncStores.sessions,
      conflictStore: syncStores.conflicts,
      backupStore: syncStores.backups,
      remoteEndpoint: () => request.remoteRoot
    })
  }
  const rsyncBackendFactory = async (_request: DevboxSyncCreateRequest): Promise<DevboxSyncBackend> => {
    const commandRunner = async (_command: 'rsync', args: readonly string[]) => {
      try {
        const result = await commandExecFileAsync('rsync', args, { env: environment })
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
        return {
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? failure.message
        }
      }
    }
    return new RsyncSyncBackend({
      profileId: options.profileId,
      commandRunner,
      sessionStore: syncStores.sessions,
      conflictStore: syncStores.conflicts,
      backupStore: syncStores.backups
    })
  }
  const interactiveChildren = new Set<ChildProcess>()
  const launchInteractive = (
    launchProfile: DevboxProfileV1,
    remoteCwd: string,
    command: readonly string[] | undefined,
    capability: unknown
  ): ChildProcess => {
    const child = spawnInteractiveSsh(
      endpoint ?? endpointFor(launchProfile),
      remoteCwd,
      command,
      capability,
      environment
    )
    interactiveChildren.add(child)
    child.once('close', () => interactiveChildren.delete(child))
    return child
  }
  const terminal: DevboxTerminalAdapter = {
    launch: async ({ profile: launchProfile, remoteCwd, command }) =>
      launchInteractive(launchProfile, remoteCwd, command, undefined)
  }
  const phi: DevboxPhiAdapter = {
    launch: async ({ profile: launchProfile, remoteCwd, capability }) =>
      launchInteractive(launchProfile, remoteCwd, ['phi'], capability)
  }
  return {
    projectHost,
    terminal,
    phi,
    jobs,
    generation,
    ports,
    syncRequests: devboxSyncRequests,
    mutagenBackendFactory,
    rsyncBackendFactory,
    dispose: async () => {
      await Promise.all([...interactiveChildren].map((child) => stopInteractiveChild(child)))
      interactiveChildren.clear()
    }
  }
}

function endpointFor(profile: DevboxProfileV1): SshEndpoint {
  const { identity, proxyCommand } = profile.sshTarget
  const extraOptions = proxySshOptions(identity.host, identity.port, proxyCommand)
  return {
    host: identity.host,
    port: identity.port,
    username: identity.username,
    ...(extraOptions.length > 0 ? { extraOptions } : {})
  }
}

function resolveRunner(
  options: DevboxStandaloneAdapterOptions,
  endpoint: SshEndpoint | null,
  profile: DevboxProfileV1 | null
): DevboxSshRunner {
  const supplied = options.ssh ?? options.sshRunner ?? options.sshRunnerFactory
  if (supplied) {
    return typeof supplied === 'function' ? supplied(endpoint ?? fallbackEndpoint(), profile) : supplied
  }
  if (endpoint) {
    return createSystemSshRunner(endpoint)
  }
  return blockedRunner
}

function fallbackEndpoint(): SshEndpoint {
  return { host: 'invalid', port: 22, username: 'invalid' }
}

const blockedRunner: DevboxSshRunner = {
  command: async () => {
    throw createDevboxError('operation_conflict', { context: { field: 'ssh-connection' } })
  },
  script: async () => {
    throw createDevboxError('operation_conflict', { context: { field: 'ssh-connection' } })
  }
}

function spawnInteractiveSsh(
  endpoint: SshEndpoint,
  remoteCwd: string,
  command: readonly string[] | undefined,
  capability: unknown,
  environment: NodeJS.ProcessEnv
): ChildProcess {
  const remoteCommand = [
    'cd',
    shellEscape(remoteCwd),
    '&&',
    'exec',
    ...(command && command.length > 0 ? command.map(shellEscape) : ['$SHELL'])
  ].join(' ')
  const env = { ...environment }
  if (capability !== undefined) {
    env[DEVBOX_BRIDGE_CAPABILITY_ENV] = JSON.stringify(capability)
    delete env.DEVBOX_REMOTE_CLI_BIN_DIR
  }
  return spawnSystemSshInteractive(endpoint, remoteCommand, { env })
}

/** Compatibility alias for callers that used the old factory spelling. */
export const createDevboxAdapters = createStandaloneDevboxAdapters
