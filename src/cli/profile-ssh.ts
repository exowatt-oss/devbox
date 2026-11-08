import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import { isLocalSshEndpoint } from '../ssh/local-endpoint'
import { createLocalRunner, runLocalInteractive } from '../ssh/local-runner'
import { createSystemSshRunner, runSystemSshInteractive } from '../ssh/system-ssh-runner'
import type { DevboxProfileStore } from '../core/devbox-profile-store'
import { proxySshOptions } from '../ssh/ssh-proxy'

export type DevboxInteractiveRunner = (
  remoteCommand: string,
  options?: { remoteForwards?: readonly string[] }
) => Promise<number>

export type DevboxProfileSshTarget = {
  profile: DevboxProfileV1
  endpoint: SshEndpoint
  ssh: DevboxSshRunner
  local: boolean
  interactive: DevboxInteractiveRunner
}

export function createDevboxProfileSshTarget(
  profileId: string,
  profileRoot: string,
  profileStore: DevboxProfileStore
): DevboxProfileSshTarget {
  const loaded = profileStore.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found')
  }
  const knownHostsFile = join(profileRoot, profileId, 'known_hosts')
  const endpoint = profileSshEndpoint(loaded.profile, existsSync(knownHostsFile) ? knownHostsFile : undefined)
  const local = isLocalSshEndpoint(endpoint)
  const ssh = local ? createLocalRunner() : createSystemSshRunner(endpoint)
  const interactive: DevboxInteractiveRunner = local
    ? (remoteCommand) => runLocalInteractive(remoteCommand)
    : (remoteCommand, options) => runSystemSshInteractive(endpoint, remoteCommand, options)
  return { profile: loaded.profile, endpoint, ssh, local, interactive }
}

/**
 * The system-ssh endpoint for a profile: identity plus, when the profile pins a
 * ProxyCommand, `-o ProxyCommand=… -o HostKeyAlias=<known_hosts token>`.
 */
export function profileSshEndpoint(
  profile: Pick<DevboxProfileV1, 'sshTarget'>,
  knownHostsFile?: string
): SshEndpoint {
  const { identity, proxyCommand } = profile.sshTarget
  const extraOptions = proxySshOptions(identity.host, identity.port, proxyCommand)
  return {
    host: identity.host,
    port: identity.port,
    username: identity.username,
    ...(knownHostsFile === undefined ? {} : { knownHostsFile }),
    ...(extraOptions.length > 0 ? { extraOptions } : {})
  }
}
