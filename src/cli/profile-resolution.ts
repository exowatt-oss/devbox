import { CliArgumentError, type FlagValue } from './args'
import type { DevboxProfileV1 } from '../shared/devbox-types'

export type DevboxProfileSelection = {
  profileId: string
  profile: DevboxProfileV1
  source: 'explicit' | 'environment' | 'configured' | 'single-profile'
}

export type DevboxProfileResolutionOptions = {
  profiles: readonly DevboxProfileV1[]
  env?: NodeJS.ProcessEnv
  configuredDefault?: string
}

/** Canonicalize the --device spelling before command handlers consume --profile. */
export function normalizeProfileSelectionFlags(flags: Map<string, FlagValue>): void {
  const profile = stringFlag(flags.get('profile'))
  const device = stringFlag(flags.get('device'))
  if (profile !== undefined && device !== undefined && profile !== device) {
    throw new CliArgumentError(`--profile and --device differ (${profile} vs ${device}); pass only one selection.`)
  }
  if (profile === undefined && device !== undefined) {
    flags.set('profile', device)
  }
}

/**
 * Resolve the profile once for every profile-scoped CLI command.
 *
 * Keeping this policy in one function is intentional: command handlers only
 * consume the resolved --profile value and do not each grow their own fallback
 * rules.
 */
export function resolveDevboxProfile(
  flags: ReadonlyMap<string, FlagValue>,
  options: DevboxProfileResolutionOptions
): DevboxProfileSelection {
  const profiles = [...options.profiles].toSorted((left, right) => left.id.localeCompare(right.id))
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))
  const explicitProfile = stringFlag(flags.get('profile'))
  const explicitDevice = stringFlag(flags.get('device'))
  if (explicitProfile !== undefined && explicitDevice !== undefined && explicitProfile !== explicitDevice) {
    throw new CliArgumentError(`--profile and --device differ (${explicitProfile} vs ${explicitDevice}); pass only one selection.`)
  }
  const explicit = explicitProfile ?? explicitDevice
  const environment = stringFlag((options.env ?? process.env).DEVBOX_PROFILE)
  const configured = stringFlag(options.configuredDefault)
  const candidates: readonly [string, string | undefined, DevboxProfileSelection['source']][] = [
    ['--profile/--device', explicit, 'explicit'],
    ['DEVBOX_PROFILE', environment, 'environment'],
    ['configured default', configured, 'configured']
  ]

  for (const [label, id, source] of candidates) {
    if (id === undefined) {
      continue
    }
    const profile = byId.get(id) ?? findDevboxProfileBySelector(profiles, id)
    if (profile) {
      return { profileId: profile.id, profile, source }
    }
    throw new CliArgumentError(profileResolutionError(id, label, profiles))
  }

  if (profiles.length === 1) {
    const profile = profiles[0]!
    return { profileId: profile.id, profile, source: 'single-profile' }
  }
  throw new CliArgumentError(profileResolutionError(undefined, undefined, profiles))
}

/** One selector rule for every surface: an exact profile id wins, then the profile's device alias. */
export function findDevboxProfileBySelector<T extends { id: string; device?: string }>(
  profiles: readonly T[],
  selector: string
): T | undefined {
  return profiles.find((candidate) => candidate.id === selector) ?? profiles.find((candidate) => candidate.device === selector)
}

function stringFlag(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function profileResolutionError(
  requested: string | undefined,
  source: string | undefined,
  profiles: readonly DevboxProfileV1[]
): string {
  const ids = profiles.map((profile) => profile.id).join(', ')
  const aliases = profiles.filter((profile) => profile.device).map((profile) => `${profile.device}→${profile.id}`).join(', ')
  const available = ids.length > 0 ? ` Available profiles: ${ids}.${aliases ? ` Devices: ${aliases}.` : ''}` : ' No profiles are configured.'
  if (requested !== undefined) {
    return `Devbox profile "${requested}" from ${source} was not found.${available} Set DEVBOX_PROFILE=<id> or run devbox profile use <id>.`
  }
  return `No profile selected.${available} Set DEVBOX_PROFILE=<id> or run devbox profile use <id>.`
}
