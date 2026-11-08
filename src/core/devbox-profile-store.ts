import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createDevboxError, type DevboxError, type DevboxErrorCode } from '../shared/devbox-errors'
import { DEVBOX_DEFAULT_MAX_ENTRY_COUNT, DEVBOX_PROFILE_SCHEMA_VERSION } from '../shared/devbox-types'
import { normalizeDevboxCredentialSyncConfig, validateDevboxCredentialSyncConfig } from './devbox-credential-sync'
import { normalizeDevboxPasteSyncConfig, validateDevboxPasteSyncConfig } from './devbox-paste-sync'
import { isValidDevboxProxyCommand } from '../ssh/ssh-proxy'
import type {
  DevboxCredentialCapabilityDeclaration,
  DevboxGitRoamingConfig,
  DevboxProfileV1,
  DevboxSyncClassConfig
} from '../shared/devbox-types'

export type DevboxProfileStoreDisabledReason =
  | 'invalid-profile-id'
  | 'malformed-profile'
  | 'newer-profile-version'
  | 'storage-error'

export type DevboxProfileStoreResult =
  | { status: 'disabled'; reason: DevboxProfileStoreDisabledReason; error: DevboxError }
  | { status: 'missing' }
  | { status: 'loaded'; profile: DevboxProfileV1 }
  | { status: 'saved'; profile: DevboxProfileV1 }

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\\u0000')
const safeId = (value: unknown): value is string =>
  text(value) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())
const relative = (value: unknown): value is string => {
  if (!text(value)) {return false}
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalized.length > 0 && !normalized.split('/').some((part) => part === '..' || part.length === 0) && !normalized.startsWith('/') && !/^[A-Za-z]:[\\\\/]/.test(normalized)
}
const excludePattern = (value: unknown): value is string => text(value) && relative(value.trim().replace(/^\//u, '')) // one leading `/` anchors to the sync root (Mutagen and rsync agree)
const absolutePath = (value: unknown): value is string => text(value) && isAbsolute(value.trim()) && !value.includes('\u0000')
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const noSecrets = (value: unknown): boolean =>
  !/(?:"|')?(?:secret|token|password|private)(?:"|')?\s*:/i.test(JSON.stringify(value))
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' &&
  (/^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(value) || /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(value))
export const defaultDevboxGitRoamingConfig = (): DevboxGitRoamingConfig => ({
  enabled: false,
  topology: 'working-tree-only',
  authorityScope: 'profile',
  parkedGitName: '.git.devbox-parked',
  refreshStrategy: 'origin',
  requireCleanHandoff: true,
  requirePublishedHead: true,
  excludeWorktrees: true,
  ignorePatterns: []
})

function validGitRoaming(value: unknown): value is DevboxGitRoamingConfig {
  return (
    object(value) &&
    typeof value.enabled === 'boolean' &&
    value.topology === 'working-tree-only' &&
    value.authorityScope === 'profile' &&
    value.parkedGitName === '.git.devbox-parked' &&
    value.refreshStrategy === 'origin' &&
    value.requireCleanHandoff === true &&
    value.requirePublishedHead === true &&
    value.excludeWorktrees === true &&
    Array.isArray(value.ignorePatterns) &&
    value.ignorePatterns.every((item) => object(item) && excludePattern(item.pattern) && (item.rootClass === 'all' || safeId(item.rootClass)))
  )
}

const syncPairs = new Set([
  'portable-working:mutagen:two-way-safe',
  'portable-working:mutagen:directional',
  'portable-working:rsync-fallback:two-way-safe',
  'portable-working:rsync-fallback:directional',
  'portable-declarative:mutagen:two-way-safe',
  'portable-declarative:mutagen:directional',
  'portable-declarative:rsync-fallback:two-way-safe',
  'portable-declarative:rsync-fallback:directional',
  'git-durable:rsync-fallback:checkpoint-only',
  'session-durable:rsync-fallback:authority-only',
  'generated:rsync-fallback:rebuild-on-host',
  'credentials:rsync-fallback:broker-only',
  'stateful-service:rsync-fallback:host-local',
  'unsupported:rsync-fallback:excluded'
])
function validSyncClass(value: unknown): value is DevboxSyncClassConfig {
  return (
    object(value) &&
    safeId(value.id) &&
    Array.isArray(value.excludes) &&
    value.excludes.every(excludePattern) &&
    syncPairs.has(`${String(value.kind)}:${String(value.backend)}:${String(value.mode)}`)
  )
}
function validCredential(value: unknown): value is DevboxCredentialCapabilityDeclaration {
  if (
    !object(value) ||
    !safeId(value.referenceId) ||
    Object.hasOwn(value, 'secret') ||
    Object.hasOwn(value, 'value')
  ) {
    return false
  }
  if (value.kind === 'ssh-transport') {
    return safeId(value.targetId) && value.delivery === 'devbox-managed'
  }
  if (value.kind === 'mcp-oauth') {
    return text(value.serverName) && value.delivery === 'remote-bridge'
  }
  return (
    value.kind === 'provider-auth' &&
    ['github', 'gitlab', 'anthropic', 'openai', 'google', 'custom'].includes(
      String(value.provider)
    ) &&
    ['local-browser', 'remote-enrollment'].includes(String(value.delivery))
  )
}

type ProfileValidationResult =
  | { ok: true; profile: DevboxProfileV1 }
  | { ok: false; reason: 'malformed' | 'newer-version'; message: string }
export function normalizeDevboxProfile(input: unknown): ProfileValidationResult {
  if (!object(input)) {
    return { ok: false, reason: 'malformed', message: 'Devbox profile must be an object.' }
  }
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== DEVBOX_PROFILE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: typeof input.schemaVersion === 'number' && input.schemaVersion > DEVBOX_PROFILE_SCHEMA_VERSION ? 'newer-version' : 'malformed',
      message: 'Devbox profile version is unsupported.'
    }
  }
  // A v2 profile is intentionally explicit. This also keeps an old test/fixture
  // which merely changes the version number from looking like a valid migration.
  if ((input.schemaVersion === 2 || input.schemaVersion === DEVBOX_PROFILE_SCHEMA_VERSION) && !Object.hasOwn(input, 'gitRoaming')) {
    return { ok: false, reason: 'newer-version', message: 'Devbox profile is missing its versioned Git-roaming contract.' }
  }
  if (!noSecrets(input)) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Devbox profile contains secret-bearing fields.'
    }
  }
  const ssh = input.sshTarget,
    identity = object(ssh) ? ssh.identity : undefined,
    roots = input.roots,
    toolchain = input.toolchain,
    sync = input.sync,
    classes = object(sync) && Array.isArray(sync.classes) ? sync.classes : [],
    map = input.pathMap,
    projects = input.projectDefaults,
    features = input.featureDefaults,
    slo = input.slo
  const validMap =
    Array.isArray(map) &&
    map.every(
      (entry) =>
        object(entry) &&
        safeId(entry.id) &&
        relative(entry.localRelativePath) &&
        relative(entry.remoteRelativePath) &&
        safeId(entry.syncClassId) &&
        classes.some((candidate) => object(candidate) && candidate.id === entry.syncClassId)
    )
  const validSync =
    object(sync) &&
    safeId(sync.defaultClassId) &&
    (sync.maxEntryCount === undefined || (integer(sync.maxEntryCount) && sync.maxEntryCount > 0)) && (sync.watchPollingIntervalSeconds === undefined || (integer(sync.watchPollingIntervalSeconds) && sync.watchPollingIntervalSeconds > 0)) &&
    Array.isArray(sync.excludes) &&
    sync.excludes.every(excludePattern) &&
    classes.every(validSyncClass) &&
    classes.some((candidate) => object(candidate) && candidate.id === sync.defaultClassId)
  const valid =
    safeId(input.id) &&
    text(input.displayName) &&
    (input.device === undefined || safeId(input.device)) &&
    (input.envFile === undefined || absolutePath(input.envFile)) &&
    (input.shellDir === undefined || absolutePath(input.shellDir)) && (input.credentialSync === undefined || validateDevboxCredentialSyncConfig(input.credentialSync)) && (input.pasteSync === undefined || validateDevboxPasteSyncConfig(input.pasteSync)) &&
    object(ssh) &&
    safeId(ssh.targetId) && (ssh.proxyCommand === undefined || isValidDevboxProxyCommand(ssh.proxyCommand)) &&
    object(identity) &&
    text(identity.host) &&
    integer(identity.port) &&
    identity.port > 0 &&
    identity.port <= 65535 &&
    text(identity.username) &&
    fingerprint(identity.hostKeyFingerprint) &&
    object(roots) &&
    absolutePath(roots.localRoot) &&
    absolutePath(roots.remoteRoot) &&
    validMap &&
    Array.isArray(input.credentials) &&
    input.credentials.every(validCredential) &&
    object(toolchain) &&
    safeId(toolchain.lockId) &&
    typeof toolchain.lockSha256 === 'string' &&
    /^[0-9a-f]{64}$/i.test(toolchain.lockSha256) &&
    validSync &&
    validGitRoaming(input.schemaVersion === 1 ? defaultDevboxGitRoamingConfig() : { ...(input.gitRoaming as RecordValue), ignorePatterns: (input.gitRoaming as RecordValue).ignorePatterns ?? [] }) &&
    (input.defaultAuthority === 'local' || input.defaultAuthority === 'remote') &&
    object(projects) &&
    typeof projects.remoteTerminals === 'boolean' &&
    typeof projects.remoteAgents === 'boolean' &&
    typeof projects.remoteAutomations === 'boolean' &&
    object(features) &&
    typeof features.detachedJobs === 'boolean' &&
    typeof features.closedSessionHistory === 'boolean' &&
    object(slo) &&
    integer(slo.syncLagTargetMs) &&
    integer(slo.reconnectTargetMs) &&
    integer(slo.operationRecoveryTargetMs) &&
    ['allow', 'warn', 'block'].includes(String(slo.offlineEdits))
  if (!valid) {
    return { ok: false, reason: 'malformed', message: 'Devbox profile fields are invalid.' }
  }
  const profile = input as unknown as DevboxProfileV1
  return {
    ok: true,
    profile: {
      ...profile,
      schemaVersion: DEVBOX_PROFILE_SCHEMA_VERSION,
      gitRoaming: profile.schemaVersion === 1 ? defaultDevboxGitRoamingConfig() : { ...profile.gitRoaming!, ignorePatterns: profile.gitRoaming!.ignorePatterns ?? [] },
      id: profile.id.trim(),
      displayName: profile.displayName.trim(),
      ...(profile.device === undefined ? {} : { device: profile.device.trim() }),
      ...(profile.envFile === undefined ? {} : { envFile: profile.envFile.trim() }),
      ...(profile.shellDir === undefined ? {} : { shellDir: profile.shellDir.trim() }),
      ...(profile.credentialSync === undefined ? {} : { credentialSync: normalizeDevboxCredentialSyncConfig(profile.credentialSync) }), ...(profile.pasteSync === undefined ? {} : { pasteSync: normalizeDevboxPasteSyncConfig(profile.pasteSync) }), pathMap: [...profile.pathMap].sort((a, b) => a.id.localeCompare(b.id)),
      credentials: [...profile.credentials].sort((a, b) =>
        a.referenceId.localeCompare(b.referenceId)
      ),
      sync: {
        ...profile.sync,
        maxEntryCount: profile.sync.maxEntryCount ?? DEVBOX_DEFAULT_MAX_ENTRY_COUNT,
        classes: [...profile.sync.classes].sort((a, b) => a.id.localeCompare(b.id)),
        excludes: [...profile.sync.excludes].sort()
      }
    }
  }
}
const disabled = (reason: DevboxProfileStoreDisabledReason, code: DevboxErrorCode, context?: { profileId?: string }): DevboxProfileStoreResult => ({ status: 'disabled', reason, error: createDevboxError(code, { context }) })
const mapValidationFailure = (failure: { ok: false; reason: 'malformed' | 'newer-version' }, profileId?: string): DevboxProfileStoreResult => failure.reason === 'newer-version' ? disabled('newer-profile-version', 'profile_version_unsupported', { profileId }) : disabled('malformed-profile', 'profile_malformed', { profileId })
export class DevboxProfileStore {
  private readonly rootDir: string

  constructor(options: { rootDir: string; env?: NodeJS.ProcessEnv }) { this.rootDir = options.rootDir }
  listProfiles(): readonly DevboxProfileV1[] {
    if (!existsSync(this.rootDir)) { return [] }
    try { return readdirSync(this.rootDir).filter((name) => name.endsWith('.json')).sort((left, right) => left.localeCompare(right)).flatMap((name) => { const loaded = this.loadProfile(name.slice(0, -'.json'.length)); return loaded.status === 'loaded' ? [loaded.profile] : [] }) } catch { return [] }
  }
  loadProfile(profileId: string): DevboxProfileStoreResult {
    if (!safeId(profileId)) { return disabled('invalid-profile-id', 'profile_id_invalid') }
    const normalizedId = profileId.trim()
    const path = join(this.rootDir, `${normalizedId}.json`)
    if (!existsSync(path)) { return { status: 'missing' } }
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return disabled('storage-error', 'profile_malformed', { profileId: normalizedId })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return disabled('malformed-profile', 'profile_malformed', { profileId: normalizedId })
    }
    const result = normalizeDevboxProfile(parsed)
    if (!result.ok) {return mapValidationFailure(result, normalizedId)}
    if (result.profile.id !== normalizedId) { return disabled('malformed-profile', 'profile_malformed', { profileId: normalizedId }) }
    return { status: 'loaded', profile: result.profile }
  }

  saveProfile(input: unknown): DevboxProfileStoreResult {
    const result = normalizeDevboxProfile(input)
    if (!result.ok) {return mapValidationFailure(result)}
    const profile = result.profile
    if (!safeId(profile.id)) {return disabled('invalid-profile-id', 'profile_id_invalid')}
    const path = join(this.rootDir, `${profile.id}.json`)
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const fd = openSync(tmpPath, 'w', 0o600)
      try {
        writeFileSync(fd, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmpPath, path)
    } catch {
      return disabled('storage-error', 'profile_malformed', { profileId: profile.id })
    }
    return { status: 'saved', profile }
  }
}
