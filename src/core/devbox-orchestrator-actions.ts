import { randomUUID } from 'node:crypto'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxManagedBridgeSession } from '../shared/devbox-bridge-capabilities'
import { DEVBOX_GIT_ROAMING_EXCLUSIONS, type DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxPathMapper } from './devbox-path-mapper'
import { devboxCredentialSyncRequests } from './devbox-credential-sync-requests'
import { devboxPasteSyncRequests } from './devbox-paste-sync-requests'
import type {
  DevboxJobSpec,
  DevboxJobSupervisor,
  DevboxJobLaunchResult
} from './devbox-job-supervisor'
import type { DevboxSyncCreateRequest } from '../sync/devbox-sync-backend'
import type { DevboxBridgeCapabilityBroker } from './devbox-bridge-capability-broker'
import type {
  DevboxGenerationAdapter,
  DevboxPhiAdapter,
  DevboxPortAdapter,
  DevboxProjectHostAdapter,
  DevboxTerminalAdapter
} from './devbox-orchestrator-types'

/**
 * One Mutagen session per portable class the path map (or the default class) routes to. Every portable
 * session spans the whole root pair, so a class no path-map entry uses (the
 * `portable-declarative` class profiles are created with) would only be a second session
 * over the same files with the same ignores, doubling every scan and flush.
 */
export function devboxSyncRequests(profile: DevboxProfileV1): DevboxSyncCreateRequest[] {
  const mapped = new Set([profile.sync.defaultClassId, ...profile.pathMap.map((entry) => entry.syncClassId)])
  const existingRequests: DevboxSyncCreateRequest[] = profile.sync.classes
    .filter((item) => (item.kind === 'portable-working' || item.kind === 'portable-declarative') && mapped.has(item.id))
    .map((item) => ({
      profileId: profile.id,
      sessionId: `${profile.id}-${item.id}`,
      rootClassId: item.id,
      localRoot: profile.roots.localRoot,
      remoteRoot: profile.roots.remoteRoot,
      mode: item.mode === 'two-way-safe' ? 'two-way-safe' : 'directional',
      maxEntryCount: profile.sync.maxEntryCount,
      ...(profile.sync.watchPollingIntervalSeconds === undefined ? {} : { watchPollingIntervalSeconds: profile.sync.watchPollingIntervalSeconds }),
      excludes: [...new Set([
        ...profile.sync.excludes,
        ...item.excludes,
        ...(profile.gitRoaming?.enabled ? DEVBOX_GIT_ROAMING_EXCLUSIONS : [])
      ])]
    }))
  return [
    ...existingRequests,
    ...devboxCredentialSyncRequests(profile),
    ...devboxPasteSyncRequests(profile)
  ]
}

export async function routeDevboxProject(
  profile: DevboxProfileV1,
  localPath: string,
  projectHost: DevboxProjectHostAdapter | undefined
) {
  const mapped = new DevboxPathMapper(profile).map(localPath)
  if (mapped.status !== 'mapped') {
    throw mapped.error
  }
  if (!projectHost) {
    throw createDevboxError('operation_conflict', { context: { field: 'project-host-adapter' } })
  }
  const setup = await projectHost.ensure({ profile, localPath, remotePath: mapped.mappedPath })
  return {
    setupId: setup.setupId,
    remotePath: mapped.mappedPath,
    executionHostId: setup.executionHostId
  }
}

export async function launchDevboxTerminal(
  profile: DevboxProfileV1,
  localPath: string,
  kind: 'terminal' | 'agent',
  command: readonly string[] | undefined,
  projectHost: DevboxProjectHostAdapter | undefined,
  terminal: DevboxTerminalAdapter | undefined
) {
  if (!terminal) {
    throw createDevboxError('operation_conflict', { context: { field: 'terminal-adapter' } })
  }
  const route = await routeDevboxProject(profile, localPath, projectHost)
  return terminal.launch({ profile, ...route, remoteCwd: route.remotePath, kind, command })
}

export async function launchDevboxPhi(
  profile: DevboxProfileV1,
  localPath: string,
  sessionId: string,
  relayEpoch: DevboxManagedBridgeSession['relayEpoch'],
  projectHost: DevboxProjectHostAdapter | undefined,
  phi: DevboxPhiAdapter | undefined,
  bridge: DevboxBridgeCapabilityBroker | undefined
) {
  if (!phi || !bridge) {
    throw createDevboxError('operation_conflict', { context: { field: 'phi-adapter' } })
  }
  const route = await routeDevboxProject(profile, localPath, projectHost)
  const capability = bridge.issueForPhi({
    kind: 'managed-phi-session',
    profileId: profile.id,
    targetId: profile.sshTarget.targetId,
    sessionId,
    relayEpoch,
    sshIdentity: profile.sshTarget.identity
  })
  try {
    return await phi.launch({ profile, ...route, remoteCwd: route.remotePath, capability })
  } catch (error) {
    bridge.revoke(capability.capabilityId)
    throw error
  }
}

export async function runDevboxConsistent(
  spec: DevboxJobSpec,
  jobs: DevboxJobSupervisor | undefined,
  generation: DevboxGenerationAdapter | undefined
): Promise<{ result: DevboxJobLaunchResult; generationId: string }> {
  if (!jobs || !generation) {
    throw createDevboxError('operation_conflict', { context: { field: 'consistent-run-adapters' } })
  }
  const generated = await generation.createGeneration({
    leaseOwnerId: `devbox-run-${randomUUID()}`
  })
  if (!generated.verified) {
    throw createDevboxError('operation_conflict', { context: { field: 'generation-verification' } })
  }
  if (generated.materialized === false) {
    throw createDevboxError('operation_conflict', {
      context: { field: 'remote-generation-materialization' }
    })
  }
  try {
    const result = await jobs.launch({ ...spec, cwd: generated.root, detached: true })
    if (result.job.status === 'registered') {
      throw createDevboxError('operation_conflict', { context: { field: 'job-not-running' } })
    }
    return { result, generationId: generated.id }
  } finally {
    await generated.lease?.release()
  }
}

export async function openDevboxPort(
  profile: DevboxProfileV1,
  remotePort: number,
  allowPublicListener: boolean,
  label: string | undefined,
  ports: DevboxPortAdapter | undefined
) {
  if (!ports) {
    throw createDevboxError('operation_conflict', { context: { field: 'port-adapter' } })
  }
  const listener = await ports.inspectListener({ targetId: profile.sshTarget.targetId, remotePort })
  if (listener.kind !== 'loopback' && !allowPublicListener) {
    throw createDevboxError('operation_conflict', {
      context: { field: 'public-listener-acknowledgement' }
    })
  }
  return ports.openForward({
    targetId: profile.sshTarget.targetId,
    remotePort,
    remoteHost: listener.kind === 'loopback' ? listener.address : '127.0.0.1',
    label
  })
}
