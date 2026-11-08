import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DevboxProfileConfigStore } from '../core/devbox-profile-config'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { createDevboxError } from '../shared/devbox-errors'
import {
  DEVBOX_DEFAULT_MAX_ENTRY_COUNT,
  DEVBOX_DEFAULT_WATCH_POLLING_INTERVAL_SECONDS
} from '../shared/devbox-types'

export type DevboxProfileSummary = {
  id: string
  displayName: string
  device?: string
  host: string
  port: number
  username: string
  localRoot: string
  remoteRoot: string
}

export type DevboxProfileListResult = {
  defaultProfile?: string
  profiles: readonly DevboxProfileSummary[]
}

export type DevboxProfileUseResult = {
  defaultProfile: string | null
}

export type DevboxProfileEnvFileResult = {
  profileId: string
  envFile: string | null
}

export type DevboxProfileShellDirResult = {
  profileId: string
  shellDir: string | null
}

export type DevboxProfileMaxEntryCountResult = {
  profileId: string
  maxEntryCount: number
}

export type DevboxProfileWatchPollingIntervalResult = {
  profileId: string
  watchPollingIntervalSeconds: number | null
  effectiveWatchPollingIntervalSeconds: number
}

export function listDevboxProfiles(
  profileRoot: string,
  stateRoot: string,
  env: NodeJS.ProcessEnv
): DevboxProfileListResult {
  const profiles = new DevboxProfileStore({ rootDir: profileRoot, env }).listProfiles().map((profile) => ({
    id: profile.id,
    displayName: profile.displayName,
    ...(profile.device ? { device: profile.device } : {}),
    host: profile.sshTarget.identity.host,
    port: profile.sshTarget.identity.port,
    username: profile.sshTarget.identity.username,
    localRoot: profile.roots.localRoot,
    remoteRoot: profile.roots.remoteRoot
  }))
  const defaultProfile = new DevboxProfileConfigStore(join(stateRoot, 'config.json')).getDefaultProfile()
  return {
    ...(defaultProfile && profiles.some((profile) => profile.id === defaultProfile)
      ? { defaultProfile }
      : {}),
    profiles
  }
}

export function resolveDevboxEnvFilePath(value: string, cwd = process.cwd()): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.includes('\u0000')) {
    throw new Error('Credential env file path must not be empty or contain NUL.')
  }
  const expanded = trimmed === '~' || trimmed.startsWith('~/')
    ? join(homedir(), trimmed === '~' ? '' : trimmed.slice(2))
    : trimmed
  return resolve(cwd, expanded)
}

export function setDevboxProfileEnvFile(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  envFile: string | undefined
): DevboxProfileEnvFileResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  const saved = store.saveProfile({ ...loaded.profile, envFile })
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed', { context: { profileId } })
  }
  return { profileId: saved.profile.id, envFile: saved.profile.envFile ?? null }
}

export function showDevboxProfileEnvFile(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileEnvFileResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  return { profileId: loaded.profile.id, envFile: loaded.profile.envFile ?? null }
}

export function setDevboxProfileShellDir(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  shellDir: string | undefined
): DevboxProfileShellDirResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  const saved = store.saveProfile({ ...loaded.profile, shellDir })
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed', { context: { profileId } })
  }
  return { profileId: saved.profile.id, shellDir: saved.profile.shellDir ?? null }
}

export function showDevboxProfileShellDir(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileShellDirResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  return { profileId: loaded.profile.id, shellDir: loaded.profile.shellDir ?? null }
}

export function setDevboxProfileMaxEntryCount(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  maxEntryCount: number | undefined
): DevboxProfileMaxEntryCountResult {
  if (maxEntryCount !== undefined && (!Number.isSafeInteger(maxEntryCount) || maxEntryCount < 1)) {
    throw createDevboxError('operation_conflict', {
      message: 'Mutagen max entry count must be a positive safe integer.',
      context: { field: 'max-entry-count' }
    })
  }
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  const saved = store.saveProfile({
    ...loaded.profile,
    sync: { ...loaded.profile.sync, maxEntryCount: maxEntryCount ?? DEVBOX_DEFAULT_MAX_ENTRY_COUNT }
  })
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed', { context: { profileId } })
  }
  return { profileId: saved.profile.id, maxEntryCount: saved.profile.sync.maxEntryCount ?? DEVBOX_DEFAULT_MAX_ENTRY_COUNT }
}

export function showDevboxProfileMaxEntryCount(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileMaxEntryCountResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  return { profileId: loaded.profile.id, maxEntryCount: loaded.profile.sync.maxEntryCount ?? DEVBOX_DEFAULT_MAX_ENTRY_COUNT }
}

export function setDevboxProfileWatchPollingInterval(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  watchPollingIntervalSeconds: number | undefined
): DevboxProfileWatchPollingIntervalResult {
  if (watchPollingIntervalSeconds !== undefined && (!Number.isSafeInteger(watchPollingIntervalSeconds) || watchPollingIntervalSeconds < 1)) {
    throw createDevboxError('operation_conflict', {
      message: 'Mutagen watch polling interval must be a positive safe integer.',
      context: { field: 'watch-polling-interval' }
    })
  }
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  const sync = { ...loaded.profile.sync }
  if (watchPollingIntervalSeconds === undefined) {
    delete sync.watchPollingIntervalSeconds
  } else {
    sync.watchPollingIntervalSeconds = watchPollingIntervalSeconds
  }
  const saved = store.saveProfile({ ...loaded.profile, sync })
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed', { context: { profileId } })
  }
  const effective = saved.profile.sync.watchPollingIntervalSeconds ?? DEVBOX_DEFAULT_WATCH_POLLING_INTERVAL_SECONDS
  return {
    profileId: saved.profile.id,
    watchPollingIntervalSeconds: saved.profile.sync.watchPollingIntervalSeconds ?? null,
    effectiveWatchPollingIntervalSeconds: effective
  }
}

export function showDevboxProfileWatchPollingInterval(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileWatchPollingIntervalResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  const watchPollingIntervalSeconds = loaded.profile.sync.watchPollingIntervalSeconds ?? null
  return {
    profileId: loaded.profile.id,
    watchPollingIntervalSeconds,
    effectiveWatchPollingIntervalSeconds: watchPollingIntervalSeconds ?? DEVBOX_DEFAULT_WATCH_POLLING_INTERVAL_SECONDS
  }
}

export function useDevboxProfile(
  profileRoot: string,
  stateRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string | undefined
): DevboxProfileUseResult {
  if (profileId !== undefined && !new DevboxProfileStore({ rootDir: profileRoot, env }).listProfiles().some((profile) => profile.id === profileId)) {
    throw createDevboxError('profile_not_found', { context: { profileId } })
  }
  const config = new DevboxProfileConfigStore(join(stateRoot, 'config.json')).setDefaultProfile(profileId)
  return { defaultProfile: config.defaultProfile ?? null }
}
