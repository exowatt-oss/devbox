import { join } from 'node:path'
import { resolveMutagenBinary } from '../sync/mutagen-resolver'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxProfileSshTarget } from './profile-ssh'
import type { HubView, MutagenDaemonProbe, MutagenDaemonServiceState, MutagenStatusResult } from './hub-types'
import { hubIdForRoot, loadOrCreateSpokeIdentity } from './spoke-identity'
import { readHub, touchSpoke, type HubRegistryTarget, type SpokeFacts } from './hub-registry'
import { listMutagenSessionViews, type AuxiliarySessionRoot, type ListMutagenSessionViewsResult } from './mutagen-sessions'
import { probeMutagenDaemon } from './mutagen-daemon-probe'
import type { MutagenDaemonService, ServiceExec } from './mutagen-service'
import { readSyncLockHolder, syncLockPath } from './sync-now-lock'

type StatusTarget = { host: string; user: string; remoteRoot: string; localRoot: string }

export type MutagenStatusDeps = {
  stateRoot: string
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  devboxVersion?: string
  hostname?: string
  username?: string
  daemonService: MutagenDaemonService
  loadProfile?: (profileId: string) => DevboxProfileV1
  sshTarget?: (profileId: string) => DevboxProfileSshTarget
  exec?: ServiceExec
  resolveBinary?: () => Promise<string>
  probe?: typeof probeMutagenDaemon
  listSessions?: (options: Parameters<typeof listMutagenSessionViews>[0]) => Promise<ListMutagenSessionViewsResult>
  readHub?: typeof readHub
  touchSpoke?: typeof touchSpoke
  now?: () => Date
  /** True while a `db sync` (or daemon restart) holds the run lock. */
  syncRunning?: () => boolean
}

export async function assembleMutagenStatus(deps: MutagenStatusDeps, profileId: string | undefined, options: { remote: boolean }): Promise<MutagenStatusResult> {
  const dataDirectory = join(deps.stateRoot, 'mutagen')
  let binaryPath: string | null = null
  let binaryHint: string | undefined
  try {
    binaryPath = await (deps.resolveBinary ?? (() => resolveMutagenBinary({ env: deps.env, home: deps.home, platform: deps.platform })))()
  } catch (error) {
    binaryHint = error instanceof Error ? error.message : String(error)
  }
  const service = await deps.daemonService.describe()
  const probe = deps.probe ?? probeMutagenDaemon
  const daemon = await probe({ dataDirectory, binaryPath, platform: deps.platform, exec: deps.exec, servicePid: service.pid })
  const profile = profileId && deps.loadProfile ? deps.loadProfile(profileId) : undefined
  const hubFacts = profile && profileId ? targetFacts(deps, profileId, profile) : undefined
  const hubTarget = options.remote && profileId && deps.sshTarget ? deps.sshTarget(profileId) : undefined
  const list = binaryPath
    ? await (deps.listSessions ?? listMutagenSessionViews)({ binaryPath, dataDirectory, profileId, env: deps.env, exec: deps.exec, ...(hubFacts && profile ? { hub: sessionHub(hubFacts, profile) } : {}) })
    : { available: false, sessions: [], detail: binaryHint ?? 'Mutagen binary is unavailable.' }
  const violations = list.sessions.filter((session) => session.topology === 'violation').map((session) => `${session.name ?? session.identifier}: ${session.topologyDetail ?? 'invalid topology'}`)
  const hub = options.remote && profileId && hubFacts && hubTarget
    ? await readRemoteHub(hubTarget, hubFacts, deps)
    : null
  const hints = buildHints(service, daemon, list, violations, hub, binaryHint)
  // Devbox never leaves a session live: one running while no `db sync` holds the lock is a lost pause.
  const running = list.sessions.filter((session) => !session.paused).length
  if (running > 0 && !(deps.syncRunning ?? (() => readSyncLockHolder(syncLockPath(deps.stateRoot)) !== undefined))()) {
    hints.push(`${running} Devbox session(s) running outside \`db sync\` (Devbox only syncs on demand and every 10 min); \`db sync\` or \`devbox mutagen pause --profile <id>\` pauses them.`)
  }
  return {
    profileId: profileId ?? null,
    binary: { path: binaryPath, version: daemon.version, dataDirectory },
    service,
    daemon,
    sessions: list.sessions,
    topology: { verdict: list.sessions.length === 0 ? 'no-sessions' : violations.length > 0 ? 'violation' : 'ok', violations },
    hub,
    hints
  }
}

async function readRemoteHub(target: DevboxProfileSshTarget, facts: SpokeFacts, deps: MutagenStatusDeps): Promise<HubView> {
  const registryTarget: HubRegistryTarget = { ssh: target.ssh, host: factsHost(target), port: target.endpoint.port, user: factsUser(target), remoteRoot: target.profile.roots.remoteRoot }
  try {
    const result = await (deps.touchSpoke ?? touchSpoke)(registryTarget, facts, { now: deps.now })
    if (result) {return result}
    return await (deps.readHub ?? readHub)(registryTarget, facts.spokeId)
  } catch (error) {
    return unreachableHub(registryTarget, facts.spokeId, error)
  }
}

function unreachableHub(target: HubRegistryTarget, spokeId: string, error: unknown): HubView {
  const detail = error instanceof Error ? error.message : String(error)
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
    detail: detail.replace(/[\r\n]+/gu, ' ').trim() || 'Unable to reach the hub.'
  }
}

function targetFacts(deps: MutagenStatusDeps, profileId: string, profile: DevboxProfileV1): StatusTarget & SpokeFacts {
  const identity = profile.sshTarget.identity
  const spoke = loadOrCreateSpokeIdentity(deps.stateRoot)
  return {
    host: identity.host,
    user: identity.username,
    remoteRoot: profile.roots.remoteRoot,
    localRoot: profile.roots.localRoot,
    spokeId: spoke.spokeId,
    hostname: deps.hostname ?? 'unknown',
    platform: deps.platform,
    username: deps.username ?? deps.env.USER ?? 'unknown',
    profileId,
    devboxVersion: deps.devboxVersion ?? '0.3.0'
  }
}

/** The session topology check also accepts Devbox's own paste/credential roots on the same hub endpoint. */
function sessionHub(target: StatusTarget, profile: DevboxProfileV1): StatusTarget & { auxiliaryRoots: AuxiliarySessionRoot[] } {
  const auxiliaryRoots: AuxiliarySessionRoot[] = [
    ...(profile.pasteSync?.roots ?? []).map((root) => ({ rootClass: 'paste' as const, localRoot: root.localRoot, remoteRoot: root.remoteRoot })),
    ...(profile.credentialSync?.roots ?? []).map((root) => ({ rootClass: 'credentials' as const, localRoot: root.localRoot, remoteRoot: root.remoteRoot }))
  ]
  return { host: target.host, user: target.user, remoteRoot: target.remoteRoot, localRoot: target.localRoot, auxiliaryRoots }
}

function factsHost(target: DevboxProfileSshTarget): string { return target.profile.sshTarget.identity.host }
function factsUser(target: DevboxProfileSshTarget): string { return target.profile.sshTarget.identity.username }

function buildHints(service: MutagenDaemonServiceState, daemon: MutagenDaemonProbe, list: ListMutagenSessionViewsResult, violations: readonly string[], hub: HubView | null, binaryHint?: string): string[] {
  const hints: string[] = []
  if (daemon.origin === 'unknown' && !daemon.running) {hints.push('Unable to determine whether the app-private daemon is running; the process probe failed.')}
  if (!service.installed) {hints.push('Run `devbox mutagen setup` to keep the daemon alive across reboots.')}
  else if (!daemon.running && daemon.origin !== 'unknown') {hints.push('The keepalive service is installed but no daemon runs: `devbox mutagen start`, then `devbox mutagen logs`.')}
  else if (daemon.origin === 'on-demand') {hints.push('A devbox command started this daemon; `devbox mutagen setup` hands it over to the service.')}
  if (binaryHint) {hints.push(binaryHint)}
  if (!list.available) {hints.push(`${list.detail ?? 'Mutagen sessions are unavailable.'} Start the daemon with ` + '`devbox mutagen start` (or `devbox pair`).')}
  if (violations.length) {hints.push('Devbox never syncs local ↔ local; terminate the offending session with `devbox disable` and re-pair.')}
  if (hub && !hub.reachable) {hints.push(hub.detail ?? 'Hub is unreachable; verify SSH access and run `devbox mutagen setup`.')}
  else if (hub && hub.reachable && !hub.registered) {hints.push('Register this spoke on the hub with `devbox mutagen setup`.')}
  const conflictCount = list.sessions.reduce((total, session) => total + session.conflictCount, 0)
  if (conflictCount > 0) {hints.push(`${conflictCount} conflict(s): see ` + '`devbox status --json` and docs/devbox-recovery.md §4.')}
  if (service.platform === 'linux' && service.detail) {hints.push(service.detail)}
  return hints
}
