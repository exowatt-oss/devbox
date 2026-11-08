import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxShellListResult, DevboxShellSession } from './shell-sessions'
import { devboxShellProbeCacheKey, type DevboxShellProbeCache } from './shell-probe-cache'

export type DevboxDeviceGroup = {
  device: string
  host: string
  port: number
  username: string
  profiles: DevboxProfileV1[]
}

export type DevboxDeviceProfileResult = {
  profileId: string
  device?: string
  default: boolean
  reachable: boolean
  error?: string
  mostRecentId: number | null
  sessions: DevboxShellSession[]
}

export type DevboxShellDeviceStatus = 'ok' | 'unreachable' | 'skipped'

export type DevboxShellDeviceResult = {
  device: string
  host: string
  port: number
  username: string
  /** True when the configured default profile lives on this device. */
  default: boolean
  status: DevboxShellDeviceStatus
  /** Wall time of this device's probe (0 when skipped from the unreachable memory). */
  elapsedMs: number
  error?: string
  /** Epoch ms of the remembered failure when status is 'skipped'. */
  unreachableAt?: number
  profiles: DevboxDeviceProfileResult[]
}

export type DevboxShellDevicesListResult = {
  scope: 'all-devices'
  defaultProfileId?: string
  devices: DevboxShellDeviceResult[]
  sessionCount: number
  unreachableCount: number
  elapsedMs: number
  mostRecent?: { profileId: string; device: string; id: number; name?: string }
}

export type DevboxShellDevicesProgress =
  | { type: 'plan'; groups: readonly DevboxDeviceGroup[]; defaultProfileId?: string }
  | { type: 'start'; group: DevboxDeviceGroup }
  | { type: 'waking'; group: DevboxDeviceGroup; message: string }
  | { type: 'done'; device: DevboxShellDeviceResult }

/** List every profile of one endpoint group in a single round trip. */
export type DevboxShellDeviceProbe = (
  group: DevboxDeviceGroup,
  hooks: { onWaking: (message: string) => void }
) => Promise<ReadonlyMap<string, DevboxShellListResult>>

export type DevboxShellDevicesListOptions = {
  groups: readonly DevboxDeviceGroup[]
  defaultProfileId?: string
  probe: DevboxShellDeviceProbe
  cache?: DevboxShellProbeCache
  /** Ignore the unreachable memory and probe every device. */
  refresh?: boolean
  onProgress?: (event: DevboxShellDevicesProgress) => void
  now?: () => number
}

export function groupDevboxProfilesByDevice(
  profiles: readonly DevboxProfileV1[],
  defaultProfileId?: string
): DevboxDeviceGroup[] {
  const byEndpoint = new Map<string, DevboxProfileV1[]>()
  for (const profile of [...profiles].sort((left, right) => left.id.localeCompare(right.id))) {
    const identity = profile.sshTarget.identity
    const key = `${identity.username}@${identity.host}:${identity.port}`
    const existing = byEndpoint.get(key) ?? []
    existing.push(profile)
    byEndpoint.set(key, existing)
  }
  const groups = [...byEndpoint.values()].map((group) => {
    const first = group[0]!
    const identity = first.sshTarget.identity
    const alias = group.find((profile) => profile.device)?.device
    return {
      device: alias ?? (group.length === 1 ? first.id : identity.host),
      host: identity.host,
      port: identity.port,
      username: identity.username,
      profiles: [...group].sort((left, right) => {
        const leftDefault = left.id === defaultProfileId
        const rightDefault = right.id === defaultProfileId
        if (leftDefault !== rightDefault) {return leftDefault ? -1 : 1}
        return left.id.localeCompare(right.id)
      })
    }
  })
  return groups.sort((left, right) => {
    const leftDefault = left.profiles.some((profile) => profile.id === defaultProfileId)
    const rightDefault = right.profiles.some((profile) => profile.id === defaultProfileId)
    if (leftDefault !== rightDefault) {return leftDefault ? -1 : 1}
    return left.device.localeCompare(right.device)
  })
}

export async function listDevboxShellSessionsEverywhere(
  options: DevboxShellDevicesListOptions
): Promise<DevboxShellDevicesListResult> {
  const now = options.now ?? Date.now
  const started = now()
  notify(options, { type: 'plan', groups: options.groups, ...(options.defaultProfileId === undefined ? {} : { defaultProfileId: options.defaultProfileId }) })
  const devices = await Promise.all(options.groups.map(async (group) => {
    const device = await listGroup(group, options, now)
    notify(options, { type: 'done', device })
    return device
  }))
  let mostRecent: { profileId: string; device: string; session: DevboxShellSession } | undefined
  for (const device of devices) {
    for (const profile of device.profiles) {
      for (const session of profile.sessions) {
        if (mostRecent === undefined || isMoreRecent(session, mostRecent.session)) {
          mostRecent = { profileId: profile.profileId, device: device.device, session }
        }
      }
    }
  }
  return {
    scope: 'all-devices',
    ...(options.defaultProfileId === undefined ? {} : { defaultProfileId: options.defaultProfileId }),
    devices,
    sessionCount: devices.reduce((sum, device) => sum + device.profiles.reduce((count, profile) => count + profile.sessions.length, 0), 0),
    unreachableCount: devices.filter((device) => device.status !== 'ok').length,
    elapsedMs: Math.max(0, now() - started),
    ...(mostRecent === undefined ? {} : {
      mostRecent: {
        profileId: mostRecent.profileId,
        device: mostRecent.device,
        id: mostRecent.session.id,
        ...(mostRecent.session.name === undefined ? {} : { name: mostRecent.session.name })
      }
    })
  }
}

async function listGroup(
  group: DevboxDeviceGroup,
  options: DevboxShellDevicesListOptions,
  now: () => number
): Promise<DevboxShellDeviceResult> {
  const key = devboxShellProbeCacheKey(group)
  const base = {
    device: group.device,
    host: group.host,
    port: group.port,
    username: group.username,
    default: group.profiles.some((profile) => profile.id === options.defaultProfileId)
  }
  const remembered = options.refresh === true ? undefined : options.cache?.recentUnreachable(key)
  if (remembered !== undefined) {
    const ageSeconds = Math.max(0, Math.round((now() - remembered.at) / 1000))
    const error = `skipped: unreachable ${ageSeconds} s ago, --refresh to retry`
    return { ...base, status: 'skipped', elapsedMs: 0, error, unreachableAt: remembered.at, profiles: group.profiles.map((profile) => unreachableProfile(profile, options, error)) }
  }
  notify(options, { type: 'start', group })
  const started = now()
  try {
    const listed = await options.probe(group, { onWaking: (message) => notify(options, { type: 'waking', group, message }) })
    options.cache?.markReachable(key)
    const profiles = group.profiles.map((profile): DevboxDeviceProfileResult => {
      const list = listed.get(profile.id) ?? { profileId: profile.id, mostRecentId: null, sessions: [] }
      return {
        profileId: profile.id,
        ...(profile.device === undefined ? {} : { device: profile.device }),
        default: profile.id === options.defaultProfileId,
        reachable: true,
        mostRecentId: list.mostRecentId,
        sessions: [...list.sessions]
      }
    })
    return { ...base, status: 'ok', elapsedMs: Math.max(0, now() - started), profiles }
  } catch (cause) {
    const error = oneLineError(cause)
    options.cache?.markUnreachable(key, error)
    return { ...base, status: 'unreachable', elapsedMs: Math.max(0, now() - started), error, profiles: group.profiles.map((profile) => unreachableProfile(profile, options, error)) }
  }
}

function unreachableProfile(profile: DevboxProfileV1, options: DevboxShellDevicesListOptions, error: string): DevboxDeviceProfileResult {
  return {
    profileId: profile.id,
    ...(profile.device === undefined ? {} : { device: profile.device }),
    default: profile.id === options.defaultProfileId,
    reachable: false,
    error,
    mostRecentId: null,
    sessions: []
  }
}

function notify(options: DevboxShellDevicesListOptions, event: DevboxShellDevicesProgress): void {
  try {
    options.onProgress?.(event)
  } catch {
    // Progress rendering is cosmetic and must never fail the listing.
  }
}

function isMoreRecent(session: DevboxShellSession, current: DevboxShellSession): boolean {
  const left = session.lastUsed || session.created
  const right = current.lastUsed || current.created
  if (left !== right) {return left > right}
  if (session.created !== current.created) {return session.created > current.created}
  return session.id > current.id
}

function oneLineError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(/\r?\n/u, 1)[0]!.trim().replace(/\s+/gu, ' ') || 'unreachable'
}
