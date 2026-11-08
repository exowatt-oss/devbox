import { CliArgumentError } from './args'
import type { DevboxProfileListResult, DevboxProfileSummary, DevboxProfileUseResult } from './profile-preferences'
import { findDevboxProfileBySelector } from './profile-resolution'

/** The two existing profile operations the device view is built on; no state of its own. */
export type DevboxDeviceService = {
  listProfiles(): DevboxProfileListResult
  useProfile(profileId: string | undefined): DevboxProfileUseResult
}

export type DevboxDeviceEntry = {
  device: string | null
  profileId: string
  username: string
  host: string
  port: number
  default: boolean
}

export type DevboxDeviceListResult = {
  defaultProfile?: string
  defaultDevice?: string
  devices: DevboxDeviceEntry[]
}

export type DevboxDeviceDefaultResult = {
  action: 'set' | 'show' | 'clear'
  defaultProfile: string | null
  device: string | null
  username?: string
  host?: string
  port?: number
  /** DEVBOX_PROFILE set in this environment wins over the configured default. */
  environmentOverride?: string
}

export function listDevboxDevices(service: DevboxDeviceService): DevboxDeviceListResult {
  const listed = service.listProfiles()
  const devices = listed.profiles
    .map((profile) => toEntry(profile, listed.defaultProfile))
    .toSorted((left, right) => label(left).localeCompare(label(right)))
  const current = devices.find((entry) => entry.default)
  return {
    ...(current === undefined ? {} : { defaultProfile: current.profileId }),
    ...(current?.device ? { defaultDevice: current.device } : {}),
    devices
  }
}

/** `device --default <selector>`: resolve alias (or id) to the profile, then `profile use <id>`. */
export function setDevboxDefaultDevice(
  service: DevboxDeviceService,
  selector: string,
  env: NodeJS.ProcessEnv = process.env
): DevboxDeviceDefaultResult {
  const requested = selector.trim()
  const listed = service.listProfiles()
  const profile = requested.length > 0 ? findDevboxProfileBySelector(listed.profiles, requested) : undefined
  if (profile === undefined) {
    throw new CliArgumentError(unknownDeviceMessage(requested, listed.profiles))
  }
  service.useProfile(profile.id)
  return describe('set', profile, env)
}

export function showDevboxDefaultDevice(
  service: DevboxDeviceService,
  env: NodeJS.ProcessEnv = process.env
): DevboxDeviceDefaultResult {
  const listed = service.listProfiles()
  const current = listed.defaultProfile === undefined
    ? undefined
    : listed.profiles.find((profile) => profile.id === listed.defaultProfile)
  return describe('show', current, env)
}

export function clearDevboxDefaultDevice(
  service: DevboxDeviceService,
  env: NodeJS.ProcessEnv = process.env
): DevboxDeviceDefaultResult {
  service.useProfile(undefined)
  return describe('clear', undefined, env)
}

function describe(
  action: DevboxDeviceDefaultResult['action'],
  profile: DevboxProfileSummary | undefined,
  env: NodeJS.ProcessEnv
): DevboxDeviceDefaultResult {
  const override = env.DEVBOX_PROFILE?.trim()
  return {
    action,
    defaultProfile: profile?.id ?? null,
    device: profile?.device ?? null,
    ...(profile === undefined ? {} : { username: profile.username, host: profile.host, port: profile.port }),
    ...(override ? { environmentOverride: override } : {})
  }
}

function toEntry(profile: DevboxProfileSummary, defaultProfile: string | undefined): DevboxDeviceEntry {
  return {
    device: profile.device ?? null,
    profileId: profile.id,
    username: profile.username,
    host: profile.host,
    port: profile.port,
    default: profile.id === defaultProfile
  }
}

function label(entry: DevboxDeviceEntry): string {
  return entry.device ?? entry.profileId
}

function unknownDeviceMessage(requested: string, profiles: readonly DevboxProfileSummary[]): string {
  if (profiles.length === 0) {
    return `Unknown device "${requested}": no profiles are configured. Run devbox init or devbox profile create first.`
  }
  const known = profiles
    .map((profile) => profile.device ? `${profile.device} (profile ${profile.id})` : `${profile.id} (no alias)`)
    .toSorted()
    .join(', ')
  return `Unknown device "${requested}". Known devices: ${known}. Give a profile an alias with devbox profile device set <alias> --profile <id>.`
}
