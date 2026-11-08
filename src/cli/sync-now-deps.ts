import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { isLocalSshEndpoint } from '../ssh/local-endpoint'
import { resolveMutagenBinary } from '../sync/mutagen-resolver'
import { profileSshEndpoint } from './profile-ssh'
import { runSyncNow, type SyncNowDeps, type SyncNowOptions } from './sync-now'
import { boundedServiceExec } from './sync-now-exec'
import { createSyncHooks } from './sync-now-hooks'
import { acquireSyncLock, syncLockPath } from './sync-now-lock'
import { createSyncNowMutagen } from './sync-now-mutagen'
import { createSyncReach } from './sync-now-reach'
import type { SyncNowListener, SyncNowResult } from './sync-now-types'

export type SyncNowServiceContext = {
  stateRoot: string
  profileRoot: string
  env: NodeJS.ProcessEnv
  home: string
  /** The keepalive-service start path (`devbox mutagen start`). */
  startDaemon: () => Promise<unknown>
}

/** Production wiring: the devbox-private Mutagen daemon, saved profiles, system ssh, real hooks and lock. */
export async function createSyncNowDeps(context: SyncNowServiceContext): Promise<SyncNowDeps> {
  const binaryPath = await resolveMutagenBinary({ env: context.env, home: context.home })
  const store = new DevboxProfileStore({ rootDir: context.profileRoot, env: context.env })
  return {
    mutagen: createSyncNowMutagen({ binaryPath, dataDirectory: join(context.stateRoot, 'mutagen'), env: context.env }),
    profiles: () => store.listProfiles(),
    endpointFor: (profile) => {
      const knownHosts = join(context.profileRoot, profile.id, 'known_hosts')
      return profileSshEndpoint(profile, existsSync(knownHosts) ? knownHosts : undefined)
    },
    isLocal: (endpoint) => isLocalSshEndpoint(endpoint),
    home: context.home,
    tmpDir: tmpdir(),
    // Optional provider check uses a bounded exec; without DEVBOX_POWER_CLI only SSH is probed.
    reach: createSyncReach({ exec: boundedServiceExec, home: context.home, powerCli: context.env.DEVBOX_POWER_CLI }),
    hooks: createSyncHooks({ stateRoot: context.stateRoot, env: context.env }),
    acquireLock: (onWait, signal) => acquireSyncLock({ path: syncLockPath(context.stateRoot), onWait, signal }),
    startDaemon: context.startDaemon
  }
}

export async function runSyncNowForService(
  context: SyncNowServiceContext,
  options: SyncNowOptions,
  listener: SyncNowListener,
  signal?: AbortSignal
): Promise<SyncNowResult> {
  return runSyncNow(options, await createSyncNowDeps(context), listener, signal)
}
