import { join } from 'node:path'
import { DevboxProfileConfigStore } from '../core/devbox-profile-config'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import type { FlagValue } from './args'
import { resolveDevboxStateRoot } from './operations'
import { resolveDevboxProfile, type DevboxProfileSelection } from './profile-resolution'

export function profileScopedCommand(path: readonly string[]): boolean {
  // `sync` spans every machine; --profile/--device only narrow it (no default-profile fallback).
  if (path[0] === 'init' || path[0] === 'connect' || path[0] === 'device' || path[0] === 'sync') {
    return false
  }
  if (path[0] === 'mutagen' && ['start', 'stop', 'restart', 'delete', 'uninstall', 'logs'].includes(path[1] ?? '')) {
    return false
  }
  return path.length > 0 && !(path[0] === 'profile' && ['create', 'list', 'use'].includes(path[1] ?? ''))
}

export function resolveCommandProfile(
  path: readonly string[],
  flags: ReadonlyMap<string, FlagValue>,
  env: NodeJS.ProcessEnv,
  positionalArgs: readonly string[] = []
): DevboxProfileSelection | undefined {
  const scoped = profileScopedCommand(path)
  const shellVerb = positionalArgs[0]
  const shellTarget = positionalArgs[1]
  const shellTargetLookup = path[0] === 'shell' && (
    (shellVerb === 'rm' && shellTarget !== undefined && shellTarget !== 'this') ||
    (shellVerb !== undefined && !['ls', 'new', 'resume', 'reconnect', 'rm'].includes(shellVerb))
  )
  const shellProfileOptional = path[0] === 'shell' && (
    (shellVerb === 'rm' && shellTarget === 'this') ||
    (shellVerb === 'ls' || flags.get('list') === true) ||
    (shellVerb === 'rm' && flags.get('all-devices') === true) ||
    // reconnect --all covers every device like ls unless --profile/--device narrows it.
    (shellVerb === 'reconnect' && flags.get('all') === true) ||
    shellTargetLookup
  )
  const optional = (path[0] === 'mutagen' && ['status', 'setup'].includes(path[1] ?? '')) || shellProfileOptional
  if (!scoped && !optional) {
    return undefined
  }
  const stateRoot = resolveDevboxStateRoot(env)
  const profiles = new DevboxProfileStore({
    rootDir: join(stateRoot, 'profiles'),
    env
  }).listProfiles()
  const configuredDefault = new DevboxProfileConfigStore(
    join(stateRoot, 'config.json')
  ).getDefaultProfile()
  const explicit = typeof flags.get('profile') === 'string' || typeof flags.get('device') === 'string'
  const environment = env.DEVBOX_PROFILE?.trim()
  const hasSelection = explicit || (environment !== undefined && environment.length > 0) || configuredDefault !== undefined

  // Status/setup are useful before any profile exists. Preserve that escape hatch
  // without swallowing a bad DEVBOX_PROFILE or configured default.
  if (optional && !hasSelection && profiles.length !== 1) {
    return undefined
  }
  return resolveDevboxProfile(flags, {
    profiles,
    env,
    configuredDefault
  })
}
