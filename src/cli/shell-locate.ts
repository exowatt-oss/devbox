import { CliArgumentError } from './args'
import { resolveDevboxShellTarget, type OwnedCanonicalShell } from './shell-lifecycle'
import { groupDevboxProfilesByDevice, type DevboxDeviceGroup } from './shell-devices'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxShellListResult } from './shell-sessions'

export type DevboxShellLocation = {
  profileId: string
  device: string
  note?: string
}

export async function locateDevboxShellTarget(options: {
  target: string
  preferredProfileId?: string
  profiles: readonly DevboxProfileV1[]
  list: (profileId: string, timeoutMs?: number) => Promise<DevboxShellListResult>
  timeoutMs?: number
}): Promise<DevboxShellLocation> {
  const profiles = [...options.profiles].sort((left, right) => left.id.localeCompare(right.id))
  const preferred = profiles.find((profile) => profile.id === options.preferredProfileId) ?? profiles[0]
  if (preferred === undefined) {throw notFound(options.target, [], new Map())}
  const groups = groupDevboxProfilesByDevice(profiles, options.preferredProfileId)
  const listed = new Map<string, DevboxShellListResult>()
  let preferredHadSessions = false
  try {
    const result = await options.list(preferred.id, options.timeoutMs)
    listed.set(preferred.id, result)
    preferredHadSessions = result.sessions.length > 0
    const match = matchTarget(options.target, result)
    if (match !== undefined) {
      return { profileId: preferred.id, device: deviceFor(groups, preferred.id) }
    }
  } catch {
    // A failed preferred profile should not prevent another device from being found.
  }

  const numeric = /^[1-9][0-9]*$/u.test(options.target)
  const shouldSearchOthers = !numeric || !preferredHadSessions
  if (shouldSearchOthers) {
    const others = profiles.filter((profile) => profile.id !== preferred.id)
    const results = await Promise.allSettled(others.map((profile) => Promise.resolve().then(() => options.list(profile.id, options.timeoutMs))))
    for (const [index, profile] of others.entries()) {
      const result = results[index]!
      if (result.status === 'fulfilled') {listed.set(profile.id, result.value)}
    }
  }

  const matches = [...listed.entries()]
    .filter(([, result]) => matchTarget(options.target, result) !== undefined)
    .map(([profileId]) => profileId)
  if (matches.length === 1) {
    const profileId = matches[0]!
    const device = deviceFor(groups, profileId)
    return {
      profileId,
      device,
      ...(profileId === preferred.id ? {} : {
        note: `devbox: shell '${options.target}' is on device ${device} (profile ${profileId})`
      })
    }
  }
  if (matches.length > 1) {
    const choices = matches.map((profileId) => `--device ${deviceFor(groups, profileId)} (profile ${profileId})`).join(', ')
    throw new CliArgumentError(`Shell target '${options.target}' is ambiguous; choose one of: ${choices}`)
  }
  throw notFound(options.target, groups, listed)
}

function matchTarget(target: string, result: DevboxShellListResult): OwnedCanonicalShell | undefined {
  const sessions = result.sessions.map((session) => ({ canonical: true as const, session, socketName: undefined }))
  try {
    return resolveDevboxShellTarget(target, sessions)
  } catch {
    return undefined
  }
}

function deviceFor(groups: readonly DevboxDeviceGroup[], profileId: string): string {
  return groups.find((group) => group.profiles.some((profile) => profile.id === profileId))?.device ?? 'unknown'
}

function notFound(
  target: string,
  groups: readonly DevboxDeviceGroup[],
  listed: ReadonlyMap<string, DevboxShellListResult>
): CliArgumentError {
  const perDevice = groups.flatMap((group) => {
    const owners: string[] = []
    const sessions = group.profiles.flatMap((profile) => {
      const result = listed.get(profile.id)
      if (result?.sessions.length) {owners.push(profile.id)}
      return result?.sessions.map((session) => `${session.id}${session.name === undefined ? '' : ` (${session.name})`}`) ?? []
    })
    const label = owners.length > 0 ? `${group.device}/${owners.join(',')}` : group.device
    return sessions.length === 0 ? [] : `${label}: ${sessions.join(', ')}`
  })
  const existing = perDevice.length === 0 ? 'none' : perDevice.join(' · ')
  return new CliArgumentError(`No Devbox shell session matches '${target}'. Existing sessions: ${existing}`)
}
