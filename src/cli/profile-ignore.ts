import { createDevboxError } from '../shared/devbox-errors'
import { DEVBOX_GIT_ROAMING_EXCLUSIONS, type DevboxGitRoamingIgnore, type DevboxProfileV1, type DevboxSyncClassConfig } from '../shared/devbox-types'
import { DevboxProfileStore } from '../core/devbox-profile-store'

export type DevboxProfileIgnoreResult = {
  profileId: string
  action: 'add' | 'list' | 'rm'
  patterns: readonly DevboxGitRoamingIgnore[]
  requiresRePair: boolean
  message: string
}

/** A leading `/` anchors the pattern to the sync root (`/.data/` = only the top-level `.data`). */
export function validateIgnorePattern(pattern: string): string {
  const value = pattern.trim().replaceAll('\\', '/')
  const body = value.startsWith('/') ? value.slice(1) : value
  if (!body || body.startsWith('/') || value.includes('\u0000') || value.split('/').some((part) => part === '..')) {
    throw createDevboxError('operation_conflict', { message: `Invalid ignore pattern: ${pattern}`, context: { field: 'ignore-pattern' } })
  }
  return value
}

function load(store: DevboxProfileStore, profileId: string): DevboxProfileV1 {
  const result = store.loadProfile(profileId)
  if (result.status !== 'loaded') {throw 'error' in result ? result.error : createDevboxError('profile_not_found', { context: { profileId } })}
  return result.profile
}

function save(store: DevboxProfileStore, profile: DevboxProfileV1): DevboxProfileV1 {
  const result = store.saveProfile(profile)
  if (result.status !== 'saved') {throw 'error' in result ? result.error : createDevboxError('profile_malformed')}
  return result.profile
}

function updateClassExcludes(
  profile: DevboxProfileV1,
  patterns: readonly DevboxGitRoamingIgnore[],
  remove = false
): DevboxProfileV1['sync']['classes'] {
  return profile.sync.classes.map((item) => {
    const owned = new Set(patterns
      .filter((entry) => entry.rootClass === 'all' || entry.rootClass === item.id)
      .map((entry) => entry.pattern))
    if (owned.size === 0) {return item}
    const excludes = remove
      ? item.excludes.filter((pattern) => !owned.has(pattern))
      : [...new Set([...item.excludes, ...owned])]
    return { ...item, excludes } as DevboxSyncClassConfig
  })
}

function canonicalPatterns(profile: DevboxProfileV1): readonly DevboxGitRoamingIgnore[] {
  const legacy = profile.gitRoaming?.ignorePatterns ?? []
  const legacyByPattern = new Map(legacy.map((entry) => [entry.pattern, entry]))
  const policy = profile.gitRoaming?.enabled ? new Set(DEVBOX_GIT_ROAMING_EXCLUSIONS) : new Set<string>()
  const ordered = legacy.filter((entry) => !policy.has(entry.pattern))
  const seen = new Set(ordered.map((entry) => entry.pattern))
  for (const pattern of profile.sync.excludes) {
    if (!policy.has(pattern) && !seen.has(pattern)) {
      ordered.push(legacyByPattern.get(pattern) ?? { pattern, rootClass: 'all' })
      seen.add(pattern)
    }
  }
  return ordered
}

function result(profile: DevboxProfileV1, action: DevboxProfileIgnoreResult['action']): DevboxProfileIgnoreResult {
  return {
    profileId: profile.id,
    action,
    patterns: canonicalPatterns(profile),
    requiresRePair: true,
    message: 'Profile excludes are stored canonically in sync.excludes. Legacy gitRoaming.ignorePatterns are read and mirrored for compatibility. Ignore changes apply when a new session is created; an existing paired session requires re-pairing, and no live refresh command is exposed.'
  }
}

export function addProfileIgnores(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  requested: readonly string[],
  rootClass = 'portable-working'
): DevboxProfileIgnoreResult {
  if (!requested.length) {throw createDevboxError('operation_conflict', { message: 'At least one ignore pattern is required.', context: { field: 'ignore-pattern' } })}
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const profile = load(store, profileId)
  const classIds = new Set(profile.sync.classes.map((item) => item.id))
  if (rootClass !== 'all' && !classIds.has(rootClass)) {throw createDevboxError('operation_conflict', { message: `Unknown root class: ${rootClass}`, context: { field: 'root-class' } })}
  const additions = requested.map((pattern) => ({ pattern: validateIgnorePattern(pattern), rootClass }))
  const existing = profile.gitRoaming?.ignorePatterns ?? []
  const mergedLegacy = [...existing]
  const legacyPatterns = existing.map((entry) => entry.pattern)
  for (const entry of additions) {
    if (!mergedLegacy.some((item) => item.pattern === entry.pattern && item.rootClass === entry.rootClass)) {mergedLegacy.push(entry)}
  }
  const updated = save(store, {
    ...profile,
    gitRoaming: { ...profile.gitRoaming!, ignorePatterns: mergedLegacy },
    sync: {
      ...profile.sync,
      excludes: [...new Set([...profile.sync.excludes, ...legacyPatterns, ...additions.map((entry) => entry.pattern)])],
      classes: updateClassExcludes(profile, [...existing, ...additions])
    }
  })
  return result(updated, 'add')
}

export function listProfileIgnores(profileRoot: string, env: NodeJS.ProcessEnv, profileId: string): DevboxProfileIgnoreResult {
  return result(load(new DevboxProfileStore({ rootDir: profileRoot, env }), profileId), 'list')
}

export function removeProfileIgnores(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  requested: readonly string[]
): DevboxProfileIgnoreResult {
  if (!requested.length) {throw createDevboxError('operation_conflict', { message: 'At least one ignore pattern is required.', context: { field: 'ignore-pattern' } })}
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const profile = load(store, profileId)
  const patterns = requested.map(validateIgnorePattern)
  const removed = new Set(patterns)
  const remaining = (profile.gitRoaming?.ignorePatterns ?? []).filter((entry) => !removed.has(entry.pattern))
  const updated = save(store, {
    ...profile,
    gitRoaming: { ...profile.gitRoaming!, ignorePatterns: remaining },
    sync: {
      ...profile.sync,
      excludes: profile.sync.excludes.filter((pattern) => !removed.has(pattern)),
      classes: updateClassExcludes(profile, patterns.map((pattern) => ({ pattern, rootClass: 'all' })), true)
    }
  })
  return result(updated, 'rm')
}
