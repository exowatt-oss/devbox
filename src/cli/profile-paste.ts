import { tmpdir } from 'node:os'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import {
  clipboardPasteRoot,
  defaultDevboxPasteSyncConfig,
  disableDevboxPasteSync,
  enableDevboxPasteSync
} from '../core/devbox-paste-sync'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { DevboxPasteSyncRoot, DevboxProfileV1 } from '../shared/devbox-types'
import { createDevboxProfileSshTarget } from './profile-ssh'

export type DevboxProfilePasteOptions = {
  localRoot?: string
  remoteRoot?: string
  patterns?: readonly string[]
  /** Skip the best-effort remote `mkdir -p`; the root must then already exist remotely. */
  skipRemotePrepare?: boolean
  ssh?: DevboxSshRunner
  sshRunner?: DevboxSshRunner
}

export type DevboxProfilePasteRemoteRoot = {
  root: string
  /** `ready` when the remote directory exists and is writable by the SSH user. */
  status: 'ready' | 'unwritable' | 'unreachable' | 'skipped'
  /** Copy-paste remediation when the status is not `ready`. */
  hint?: string
}

export type DevboxProfilePasteResult = {
  profileId: string
  enabled: boolean
  updatedExistingRoot?: boolean
  roots: readonly DevboxPasteSyncRoot[]
  remoteRoot?: DevboxProfilePasteRemoteRoot
}

export async function enableDevboxProfilePaste(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  options: DevboxProfilePasteOptions = {}
): Promise<DevboxProfilePasteResult> {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const profile = loadProfile(store, profileId)
  const root = clipboardPasteRoot(options.localRoot ?? tmpdir(), options.remoteRoot, options.patterns)
  const updatedExistingRoot = profile.pasteSync?.enabled === true
  const saved = saveProfile(store, enableDevboxPasteSync(profile, root))
  const remoteRoot = options.skipRemotePrepare === true
    ? { root: root.remoteRoot, status: 'skipped' as const }
    : await prepareRemoteRoot(profileRoot, store, profileId, saved, root.remoteRoot, options.ssh ?? options.sshRunner)
  return pasteResult(saved, updatedExistingRoot ? true : undefined, remoteRoot)
}

export function disableDevboxProfilePaste(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfilePasteResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const saved = saveProfile(store, disableDevboxPasteSync(loadProfile(store, profileId)))
  return pasteResult(saved)
}

export function showDevboxProfilePaste(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfilePasteResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  return pasteResult(loadProfile(store, profileId))
}

/**
 * Mutagen will not create missing parents of a replica root, and the mirrored macOS
 * path (`/tmp/devbox-temp/...`) lives outside the remote user's home, so try to create it
 * now and turn a permission failure into a copy-paste `sudo` line instead of a failed
 * `devbox pair` later.
 */
async function prepareRemoteRoot(
  profileRoot: string,
  store: DevboxProfileStore,
  profileId: string,
  profile: DevboxProfileV1,
  remoteRoot: string,
  injectedSsh?: DevboxSshRunner
): Promise<DevboxProfilePasteRemoteRoot> {
  const username = profile.sshTarget.identity.username
  const quoted = shellQuote(remoteRoot)
  const sudoHint = `On the remote host run: sudo mkdir -p ${quoted} && sudo chown -R ${shellQuote(username)} ${quoted}`
  let ssh: DevboxSshRunner
  try {
    ssh = injectedSsh ?? createDevboxProfileSshTarget(profileId, profileRoot, store).ssh
  } catch {
    return { root: remoteRoot, status: 'unreachable', hint: sudoHint }
  }
  try {
    const output = (
      await ssh.command(`mkdir -p -- ${quoted} 2>/dev/null && test -w ${quoted} && printf ready || printf unwritable`, 15_000)
    ).trim()
    return output === 'ready'
      ? { root: remoteRoot, status: 'ready' }
      : { root: remoteRoot, status: 'unwritable', hint: sudoHint }
  } catch {
    return {
      root: remoteRoot,
      status: 'unreachable',
      hint: `Could not reach the remote host to prepare ${remoteRoot}. ${sudoHint}`
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
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

function pasteResult(
  profile: DevboxProfileV1,
  updatedExistingRoot?: boolean,
  remoteRoot?: DevboxProfilePasteRemoteRoot
): DevboxProfilePasteResult {
  const config = profile.pasteSync ?? defaultDevboxPasteSyncConfig()
  return {
    profileId: profile.id,
    enabled: config.enabled,
    ...(updatedExistingRoot === undefined ? {} : { updatedExistingRoot }),
    roots: config.roots,
    ...(remoteRoot === undefined ? {} : { remoteRoot })
  }
}
