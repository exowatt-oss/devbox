import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxBridgeCapabilityBroker } from '../core/devbox-bridge-capability-broker'
import { DevboxOrchestrator } from '../core/devbox-orchestrator'
import type { DevboxProfileStore } from '../core/devbox-profile-store'
import { createStandaloneDevboxAdapters } from '../core/devbox-standalone-adapters'
import { DevboxSyncSupervisor } from '../sync/devbox-sync-supervisor'
import { devboxSyncRequests } from '../core/devbox-orchestrator-actions'
import { makeSyncFactories } from './sync-factories'
import { cleanupRemoteAgents } from './remote-cleanup'
import { profileSshEndpoint, type DevboxProfileSshTarget } from './profile-ssh'
import type { MutagenCli } from '../sync/mutagen-cli'
import { DevboxGitRoamingController } from '../core/authority/devbox-git-roaming'
import { createLocalGitRoamingHost, createSshGitRoamingHost } from '../core/authority/devbox-git-roaming-host'
import { createHostGitRoamingMarkerStore, refreshOriginForRepositories } from '../core/authority/devbox-git-roaming-remote'
import { createSystemSshRunner } from '../ssh/system-ssh-runner'
import { runGitRoamingPreflight } from '../core/devbox-git-roaming-preflight'
import type { ScannedKey } from './profile-create'

export type DevboxProfileRuntime = {
  profileStore: DevboxProfileStore
  ssh: DevboxSshRunner
  orchestrator: DevboxOrchestrator
  gitRoaming?: DevboxGitRoamingController
  dispose: () => Promise<void>
}

export type DevboxProfileRuntimeOptions = {
  profileId: string
  stateRoot: string
  profileRoot: string
  env: NodeJS.ProcessEnv
  profileStore: DevboxProfileStore
  target: DevboxProfileSshTarget
  mutagen: MutagenCli
  createGitRoaming: (profile: DevboxProfileV1, ssh: DevboxSshRunner) => Promise<DevboxGitRoamingController | undefined>
}

export async function createProfileRuntime(options: DevboxProfileRuntimeOptions): Promise<DevboxProfileRuntime> {
  const { profileId, stateRoot, profileStore, target, mutagen } = options
  const { profile, endpoint, ssh } = target
  let factories: ReturnType<typeof makeSyncFactories> | undefined
  const getFactories = (): ReturnType<typeof makeSyncFactories> => {
    factories ??= makeSyncFactories(profile.sshTarget.identity, mutagen, undefined, options.env)
    return factories
  }
  let supervisor: DevboxSyncSupervisor | null = null
  const adapters = createStandaloneDevboxAdapters({ profileId, profileStore, stateRoot, endpoint, sshRunner: ssh, syncSupervisor: () => { if (!supervisor) { throw new Error('sync supervisor unavailable') }; return supervisor }, env: options.env })
  const bridge = new DevboxBridgeCapabilityBroker()
  const gitRoaming = await options.createGitRoaming(profile, ssh)
  const orchestrator = new DevboxOrchestrator({ profileId, profileStore, journalRoot: options.profileRoot, env: options.env, projectHost: adapters.projectHost, terminal: adapters.terminal, phi: adapters.phi, jobs: adapters.jobs, generation: adapters.generation, ports: adapters.ports, bridge, ...(gitRoaming ? { gitRoaming } : {}), supervisorFactory: ({ profile: activeProfile, journal, onStatus }) => { supervisor = new DevboxSyncSupervisor({ profileId: activeProfile.id, requests: devboxSyncRequests(activeProfile), journal, mutagenBackendFactory: getFactories().mutagenBackendFactory, rsyncBackendFactory: getFactories().rsyncBackendFactory, onStatus, onDisableCleanup: () => cleanupRemoteAgents(ssh, activeProfile) }); return supervisor } })
  return { profileStore, ssh, orchestrator, ...(gitRoaming ? { gitRoaming } : {}), dispose: async () => orchestrator.dispose() }
}

export async function runGitRoamingDryRunInventory(profile: DevboxProfileV1, keys: readonly ScannedKey[]): Promise<unknown> {
  const temporary = await mkdtemp(join(tmpdir(), 'devbox-roaming-known-hosts-'))
  const knownHosts = join(temporary, 'known_hosts')
  try {
    await writeFile(knownHosts, keys.map((key) => key.line).join(''), { encoding: 'utf8', mode: 0o600 })
    const ssh = createSystemSshRunner(profileSshEndpoint(profile, knownHosts))
    return await runGitRoamingPreflight(profile, createLocalGitRoamingHost(profile.roots.localRoot), createSshGitRoamingHost(profile.roots.remoteRoot, ssh))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function createGitRoamingController(profile: DevboxProfileV1, ssh: DevboxSshRunner, stateRoot: string): Promise<DevboxGitRoamingController | undefined> {
  if (!profile.gitRoaming?.enabled) { return undefined }
  const localHost = createLocalGitRoamingHost(profile.roots.localRoot)
  const remoteHost = createSshGitRoamingHost(profile.roots.remoteRoot, ssh)
  let marker: ReturnType<typeof createHostGitRoamingMarkerStore> | undefined
  try {
    const remoteHome = (await ssh.command('printf %s "$HOME"', 10_000)).trim()
    if (remoteHome.startsWith('/')) { marker = createHostGitRoamingMarkerStore(remoteHost, join(remoteHome, '.local/state/devbox', profile.id, 'git-roaming/peer-marker.json')) }
  } catch { /* witness health is surfaced as missing and handoff fails closed */ }
  const holdStage = process.env.DEVBOX_GIT_ROAMING_HOLD_STAGE
  const holdMs = Number(process.env.DEVBOX_GIT_ROAMING_HOLD_MS ?? 0)
  return new DevboxGitRoamingController({ profileId: profile.id, config: profile.gitRoaming, local: localHost, remote: remoteHost, stateRoot, defaultOwner: profile.defaultAuthority, ...(marker ? { marker } : {}), ...(holdStage === 'quiesced' || holdStage === 'reconciling' ? { holdStage, holdMs } : {}), refresh: async (side, repositories) => refreshOriginForRepositories(side === 'local' ? localHost : remoteHost, repositories, side) })
}
