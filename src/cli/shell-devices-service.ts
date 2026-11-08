import type { DevboxShellKillUnattachedResult, DevboxShellListResult } from './shell-sessions'
import { join } from 'node:path'
import {
  groupDevboxProfilesByDevice,
  listDevboxShellSessionsEverywhere,
  type DevboxDeviceGroup,
  type DevboxShellDevicesListResult,
  type DevboxShellDevicesProgress
} from './shell-devices'
import { createDevboxShellProbeCache } from './shell-probe-cache'
import { buildDevboxShellProbeCommand, parseDevboxShellProbeOutput } from './shell-probe-script'
import { devboxShellListBudget, runDevboxShellProbe, type DevboxShellProbeHooks, type DevboxShellProbeTarget } from './shell-probe-run'
import type { DevboxProfileV1 } from '../shared/devbox-types'

export type DevboxShellKillDevicesResult = {
  scope: 'all-devices'
  devices: {
    device: string
    profiles: {
      profileId: string
      count: number
      sessions: readonly string[]
      reachable: boolean
      error?: string
    }[]
  }[]
  count: number
}

export function createDevboxShellDevicesGroups(
  profiles: readonly DevboxProfileV1[],
  defaultProfileId?: string
): DevboxDeviceGroup[] {
  return groupDevboxProfilesByDevice(profiles, defaultProfileId)
}

/** Human label for the device that owns a profile: its group alias, else the profile id or host. */
export function devboxDeviceLabelFor(profiles: readonly DevboxProfileV1[], profileId: string): string {
  const group = groupDevboxProfilesByDevice(profiles).find((candidate) => candidate.profiles.some((profile) => profile.id === profileId))
  return group?.device ?? profileId
}

export type DevboxShellListDeps = {
  stateRoot: string
  profiles: () => readonly DevboxProfileV1[]
  defaultProfileId: () => string | undefined
  target: (profileId: string) => DevboxShellProbeTarget
  runProbe?: typeof runDevboxShellProbe
}

export type DevboxShellListAllOptions = {
  refresh?: boolean
  onProgress?: (event: DevboxShellDevicesProgress) => void
}

/** `shell ls` across devices: one parallel round trip per SSH endpoint, short budgets, unreachable memory. */
export function listShellSessionsEverywhere(
  deps: DevboxShellListDeps,
  options: DevboxShellListAllOptions = {}
): Promise<DevboxShellDevicesListResult> {
  const profiles = deps.profiles()
  const configured = deps.defaultProfileId()
  const defaultProfileId = configured !== undefined && profiles.some((profile) => profile.id === configured) ? configured : undefined
  return listDevboxShellSessionsEverywhere({
    groups: groupDevboxProfilesByDevice(profiles, defaultProfileId),
    defaultProfileId,
    probe: (group, hooks) => probeShellGroup(deps, group.profiles.map((profile) => profile.id), hooks),
    cache: createDevboxShellProbeCache(join(deps.stateRoot, 'shell-ls-unreachable.json')),
    ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress })
  })
}

/** One profile's shells in a single round trip with the listing budget (explicit `shell ls --device`). */
export async function listProfileShellSessions(deps: DevboxShellListDeps, profileId: string): Promise<DevboxShellListResult> {
  const listed = await probeShellGroup(deps, [profileId], {})
  return listed.get(profileId) ?? { profileId, mostRecentId: null, sessions: [] }
}

async function probeShellGroup(
  deps: DevboxShellListDeps,
  profileIds: readonly string[],
  hooks: DevboxShellProbeHooks
): Promise<ReadonlyMap<string, DevboxShellListResult>> {
  const target = deps.target(profileIds[0]!)
  const run = deps.runProbe ?? runDevboxShellProbe
  const stdout = await run(target, buildDevboxShellProbeCommand(profileIds), devboxShellListBudget(target.endpoint), hooks)
  return parseDevboxShellProbeOutput(profileIds, stdout).results
}

export async function killUnattachedShellSessionsEverywhere(options: {
  groups: readonly DevboxDeviceGroup[]
  kill: (profileId: string) => Promise<DevboxShellKillUnattachedResult>
}): Promise<DevboxShellKillDevicesResult> {
  const profiles = options.groups.flatMap((group) => group.profiles)
  const killed = await Promise.allSettled(profiles.map((profile) => Promise.resolve().then(() => options.kill(profile.id))))
  const byProfile = new Map<string, DevboxShellKillDevicesResult['devices'][number]['profiles'][number]>()
  let count = 0
  for (const [index, profile] of profiles.entries()) {
    const result = killed[index]!
    if (result.status === 'fulfilled') {
      count += result.value.count
      byProfile.set(profile.id, {
        profileId: profile.id,
        count: result.value.count,
        sessions: result.value.sessions,
        reachable: true
      })
    } else {
      byProfile.set(profile.id, {
        profileId: profile.id,
        count: 0,
        sessions: [],
        reachable: false,
        error: oneLineError(result.reason)
      })
    }
  }
  return {
    scope: 'all-devices',
    devices: options.groups.map((group) => ({
      device: group.device,
      profiles: group.profiles.map((profile) => byProfile.get(profile.id)!)
    })),
    count
  }
}

function oneLineError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(/\r?\n/u, 1)[0]!.trim().replace(/\s+/gu, ' ') || 'unreachable'
}
