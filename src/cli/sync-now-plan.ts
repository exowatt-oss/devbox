import { basename } from 'node:path'
import { CliArgumentError } from './args'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { SshEndpoint } from '../shared/ssh-runner-types'
import { DEVBOX_SYNC_BACKEND_LABEL, DEVBOX_SYNC_PROFILE_LABEL, DEVBOX_SYNC_ROOT_CLASS_LABEL } from '../sync/devbox-sync-backend'
import { groupDevboxProfilesByDevice } from './shell-devices'
import type { SyncSessionSnapshot } from './sync-now-session'
import type { SyncLane, SyncLaneKind, SyncMachine } from './sync-now-types'

/** Engine-side view of one machine: the contract's SyncMachine plus how to reach it. */
export type SyncNowTarget = {
  machine: SyncMachine
  /**
   * ssh endpoint for the reachability probe: the matching profile's pinned endpoint, else
   * plain `user@host` so ~/.ssh/config aliases apply (label-only sessions such as phi-sessions).
   */
  endpoint: SshEndpoint
  local: boolean
  /** ProxyCommand pinned by the matching profile, if any. */
  proxyCommand?: string
  /** Distinct devbox-profile labels on this machine, sorted. */
  profileIds: string[]
}

export type SyncNowSelection = { profile?: string; device?: string }

export type SyncNowPlanInput = {
  sessions: readonly SyncSessionSnapshot[]
  profiles: readonly DevboxProfileV1[]
  home: string
  /** os.tmpdir(): the clipboard-paste root on macOS, shown as `$TMPDIR`. */
  tmpDir?: string
  selection: SyncNowSelection
  /** The profile's ssh endpoint (ProxyCommand, HostKeyAlias, pinned known_hosts). */
  endpointFor: (profile: DevboxProfileV1) => SshEndpoint
  isLocal: (endpoint: SshEndpoint) => boolean
}

const KIND_ORDER: readonly SyncLaneKind[] = ['workspace', 'phi-sessions', 'credentials', 'images', 'other']
const KIND_LABEL: Record<SyncLaneKind, string> = { workspace: 'workspace', 'phi-sessions': 'phi sessions', credentials: 'credentials', images: 'images', other: '' }

/** Every Devbox-owned session (label devbox-backend=mutagen), grouped into machines by ssh endpoint. */
export function planSyncNow(input: SyncNowPlanInput): SyncNowTarget[] {
  const owned = input.sessions.filter((session) =>
    session.labels[DEVBOX_SYNC_BACKEND_LABEL] === 'mutagen' &&
    (session.labels[DEVBOX_SYNC_PROFILE_LABEL] ?? '').length > 0 &&
    session.beta.protocol === 'ssh' && session.beta.host !== undefined)
  const byEndpoint = new Map<string, SyncSessionSnapshot[]>()
  for (const session of owned) {
    const key = endpointKey(session.beta.user ?? '', session.beta.host!, session.beta.port ?? 22)
    byEndpoint.set(key, [...byEndpoint.get(key) ?? [], session])
  }
  const groups = groupDevboxProfilesByDevice(input.profiles)
  const targets = [...byEndpoint.entries()]
    .map(([key, sessions]) => buildTarget(key, sessions, input, groups))
    .toSorted((left, right) => left.machine.name.localeCompare(right.machine.name))
  return narrow(uniqueLaneKeys(targets), input.selection)
}

/** Lane keys are `<profile>:<kind>`; a repeat anywhere in the plan gets a `:2`, `:3`, ... suffix. */
function uniqueLaneKeys(targets: SyncNowTarget[]): SyncNowTarget[] {
  const seen = new Map<string, number>()
  return targets.map((target) => ({
    ...target,
    machine: {
      ...target.machine,
      lanes: target.machine.lanes.map((lane) => {
        const used = seen.get(lane.key) ?? 0
        seen.set(lane.key, used + 1)
        return used === 0 ? lane : { ...lane, key: `${lane.key}:${used + 1}` }
      })
    }
  }))
}

function buildTarget(
  key: string,
  sessions: readonly SyncSessionSnapshot[],
  input: SyncNowPlanInput,
  groups: ReturnType<typeof groupDevboxProfilesByDevice>
): SyncNowTarget {
  const beta = sessions[0]!.beta
  const user = beta.user ?? ''
  const host = beta.host!
  const port = beta.port ?? 22
  const profileIds = [...new Set(sessions.map((session) => session.labels[DEVBOX_SYNC_PROFILE_LABEL]!))].toSorted()
  const sameEndpoint = (profile: DevboxProfileV1): boolean => endpointKey(profile.sshTarget.identity.username, profile.sshTarget.identity.host, profile.sshTarget.identity.port) === key
  const profile = profileIds.map((id) => input.profiles.find((candidate) => candidate.id === id)).find((candidate) => candidate !== undefined && sameEndpoint(candidate)) ??
    input.profiles.toSorted((left, right) => left.id.localeCompare(right.id)).find(sameEndpoint)
  const endpoint: SshEndpoint = profile ? input.endpointFor(profile) : { host, port, username: user }
  const group = groups.find((candidate) => endpointKey(candidate.username, candidate.host, candidate.port) === key)
  const machine: SyncMachine = {
    key,
    name: group?.device ?? host,
    user,
    host,
    port,
    proxied: profile?.sshTarget.proxyCommand !== undefined,
    lanes: buildLanes(sessions, (path) => displayPath(path, input.home, input.tmpDir))
  }
  return {
    machine,
    endpoint,
    local: input.isLocal(endpoint),
    ...(profile?.sshTarget.proxyCommand === undefined ? {} : { proxyCommand: profile.sshTarget.proxyCommand }),
    profileIds
  }
}

function buildLanes(sessions: readonly SyncSessionSnapshot[], display: (path: string) => string): SyncLane[] {
  const byRoots = new Map<string, SyncSessionSnapshot[]>()
  for (const session of sessions) {
    const id = JSON.stringify([session.labels[DEVBOX_SYNC_PROFILE_LABEL], session.alpha.path ?? '', session.beta.path ?? ''])
    byRoots.set(id, [...byRoots.get(id) ?? [], session])
  }
  const lanes = [...byRoots.values()].map((members): SyncLane => {
    const first = members[0]!
    const profileId = first.labels[DEVBOX_SYNC_PROFILE_LABEL]!
    const kind = laneKind(profileId, first.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL])
    return {
      key: `${profileId}:${kind}`,
      kind,
      label: KIND_LABEL[kind] || profileId,
      profileId,
      localPath: display(first.alpha.path ?? ''),
      remotePath: first.beta.path ?? '',
      sessionIds: members.map((session) => session.id).toSorted(),
      pausedBefore: members.filter((session) => session.paused).map((session) => session.id).toSorted()
    }
  }).toSorted((left, right) =>
    KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
    left.profileId.localeCompare(right.profileId) ||
    left.localPath.localeCompare(right.localPath))
  return disambiguate(lanes)
}

/**
 * Lanes on one machine sharing a label get the profile id (workspaces are named by it
 * outright: `project`, `roam`), then the root's base name.
 */
function disambiguate(lanes: SyncLane[]): SyncLane[] {
  return lanes.map((lane) => {
    const sameLabel = lanes.filter((other) => other.label === lane.label)
    let label = lane.label
    if (sameLabel.length > 1 && new Set(sameLabel.map((other) => other.profileId)).size > 1) {label = lane.kind === 'workspace' ? lane.profileId : `${label} (${lane.profileId})`}
    if (sameLabel.filter((other) => other.profileId === lane.profileId).length > 1) {label = `${label} (${basename(lane.localPath) || lane.localPath})`}
    return { ...lane, label }
  })
}

export function laneKind(profileId: string, rootClass: string | undefined): SyncLaneKind {
  if (rootClass?.startsWith('portable-')) {return 'workspace'}
  if (rootClass === 'paste') {return 'images'}
  if (rootClass === 'credentials') {return 'credentials'}
  if (profileId === 'phi-sessions') {return 'phi-sessions'}
  return 'other'
}

function narrow(targets: SyncNowTarget[], selection: SyncNowSelection): SyncNowTarget[] {
  let selected = targets
  if (selection.device !== undefined) {
    const device = selection.device
    selected = selected.filter((target) => target.machine.name === device || target.machine.host === device || target.profileIds.includes(device))
    if (selected.length === 0) {
      const known = targets.map((target) => target.machine.name)
      throw new CliArgumentError(`Unknown device "${device}" for sync. Known devices: ${known.length > 0 ? known.join(', ') : 'none (no Devbox Mutagen sessions)'}.`)
    }
  }
  if (selection.profile !== undefined) {
    const profileId = selection.profile
    const known = [...new Set(targets.flatMap((target) => target.profileIds))].toSorted()
    if (!known.includes(profileId)) {
      throw new CliArgumentError(`Unknown profile "${profileId}" for sync. Profiles with Mutagen sessions: ${known.length > 0 ? known.join(', ') : 'none'}.`)
    }
    selected = selected.flatMap((target) => {
      const lanes = target.machine.lanes.filter((lane) => lane.profileId === profileId)
      return lanes.length === 0 ? [] : [{ ...target, profileIds: [profileId], machine: { ...target.machine, lanes } }]
    })
  }
  return selected
}

function endpointKey(user: string, host: string, port: number): string {
  return `${user}@${host}:${port}`
}

/** `$TMPDIR/…` for the paste root (a long /tmp/devbox-temp path), `~/…` under home, else as is. */
function displayPath(path: string, home: string, tmpDir: string | undefined): string {
  const tmp = tmpDir?.replace(/\/+$/u, '') ?? ''
  if (tmp.length > 1 && (path.replace(/\/+$/u, '') === tmp || path.startsWith(`${tmp}/`))) {return `$TMPDIR${path.replace(/\/+$/u, '').slice(tmp.length)}`}
  if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) {return `~${path.slice(home.length)}`}
  return path
}
