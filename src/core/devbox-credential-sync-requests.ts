import {
  DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT
} from './devbox-credential-sync'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxSyncCreateRequest } from '../sync/devbox-sync-backend'

export function devboxCredentialSyncRequests(
  profile: DevboxProfileV1
): DevboxSyncCreateRequest[] {
  const credentialSync = profile.credentialSync
  if (!credentialSync?.enabled) {
    return []
  }
  return credentialSync.roots.map((root) => ({
    profileId: profile.id,
    sessionId: `${profile.id}-credentials-${root.id}`,
    rootClassId: 'credentials',
    localRoot: root.localRoot,
    remoteRoot: root.remoteRoot,
    mode: 'two-way-resolved' as const,
    exclusionPolicy: 'explicit-only' as const,
    maxEntryCount: DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT,
    ...(profile.sync.watchPollingIntervalSeconds === undefined ? {} : { watchPollingIntervalSeconds: profile.sync.watchPollingIntervalSeconds }),
    excludes: [...new Set(root.excludes)]
  }))
}
