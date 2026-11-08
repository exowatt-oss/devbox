import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import {
  defaultDevboxCredentialSyncConfig,
  enableDevboxCredentialSync,
  disableDevboxCredentialSync,
  mcpAuthCredentialRoot
} from '../core/devbox-credential-sync'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type {
  DevboxCredentialSyncRoot,
  DevboxProfileV1
} from '../shared/devbox-types'
import { createDevboxProfileSshTarget } from './profile-ssh'

export type DevboxProfileCredentialsOptions = {
  localRoot?: string
  remoteRoot?: string
  excludes?: readonly string[]
  ssh?: DevboxSshRunner
  sshRunner?: DevboxSshRunner
}

export type DevboxProfileCredentialsResult = {
  profileId: string
  enabled: boolean
  updatedExistingRoot?: boolean
  roots: readonly DevboxCredentialSyncRoot[]
}

export async function enableDevboxProfileCredentials(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  options: DevboxProfileCredentialsOptions = {}
): Promise<DevboxProfileCredentialsResult> {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const profile = loadProfile(store, profileId)
  const remoteHome = options.remoteRoot === undefined
    ? await resolveRemoteHome(profileRoot, store, profileId, options.ssh ?? options.sshRunner)
    : dirname(options.remoteRoot)
  const defaults = mcpAuthCredentialRoot(homedir(), remoteHome)
  const root: DevboxCredentialSyncRoot = {
    ...defaults,
    localRoot: options.localRoot ?? defaults.localRoot,
    remoteRoot: options.remoteRoot ?? defaults.remoteRoot,
    excludes: [...defaults.excludes, ...(options.excludes ?? [])]
  }
  const updatedExistingRoot = profile.credentialSync?.enabled === true
  const saved = saveProfile(store, enableDevboxCredentialSync(profile, root))
  return credentialsResult(saved, updatedExistingRoot ? true : undefined)
}

export function disableDevboxProfileCredentials(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileCredentialsResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const saved = saveProfile(store, disableDevboxCredentialSync(loadProfile(store, profileId)))
  return credentialsResult(saved)
}

export function showDevboxProfileCredentials(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileCredentialsResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  return credentialsResult(loadProfile(store, profileId))
}

async function resolveRemoteHome(
  profileRoot: string,
  store: DevboxProfileStore,
  profileId: string,
  injectedSsh?: DevboxSshRunner
): Promise<string> {
  try {
    const ssh = injectedSsh ?? createDevboxProfileSshTarget(profileId, profileRoot, store).ssh
    const remoteHome = (await ssh.command('printf %s "$HOME"', 10_000)).trim()
    if (!isAbsolute(remoteHome) || remoteHome.includes('\u0000')) {
      throw new Error('remote HOME was not an absolute path')
    }
    return remoteHome
  } catch {
    throw createDevboxError('operation_conflict', {
      message: 'Could not resolve the remote $HOME for credential roaming; pass --remote-root <abs> and retry.',
      context: { field: 'credential-remote-home' }
    })
  }
}

function loadProfile(store: DevboxProfileStore, profileId: string): DevboxProfileV1 {
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded
      ? loaded.error
      : createDevboxError('profile_not_found', { context: { profileId } })
  }
  return loaded.profile
}

function saveProfile(store: DevboxProfileStore, profile: DevboxProfileV1): DevboxProfileV1 {
  const saved = store.saveProfile(profile)
  if (saved.status !== 'saved') {
    throw 'error' in saved
      ? saved.error
      : createDevboxError('profile_malformed', { context: { profileId: profile.id } })
  }
  return saved.profile
}

function credentialsResult(
  profile: DevboxProfileV1,
  updatedExistingRoot?: boolean
): DevboxProfileCredentialsResult {
  const config = profile.credentialSync ?? defaultDevboxCredentialSyncConfig()
  return {
    profileId: profile.id,
    enabled: config.enabled,
    ...(updatedExistingRoot === undefined ? {} : { updatedExistingRoot }),
    roots: config.roots
  }
}
