import { DEVBOX_PASTE_SYNC_MAX_ENTRY_COUNT, pasteSyncExcludes } from './devbox-paste-sync'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxSyncCreateRequest } from '../sync/devbox-sync-backend'

export const DEVBOX_PASTE_ROOT_CLASS_ID = 'paste' as const

/**
 * One session per paste root. The remote is a replica of the control machine: files
 * appear when pasted and disappear when the OS cleans the temp directory. Nothing on the
 * remote is ever copied back.
 */
export function devboxPasteSyncRequests(profile: DevboxProfileV1): DevboxSyncCreateRequest[] {
  const pasteSync = profile.pasteSync
  if (!pasteSync?.enabled) {
    return []
  }
  return pasteSync.roots.map((root) => ({
    profileId: profile.id,
    sessionId: `${profile.id}-${DEVBOX_PASTE_ROOT_CLASS_ID}-${root.id}`,
    rootClassId: DEVBOX_PASTE_ROOT_CLASS_ID,
    localRoot: root.localRoot,
    remoteRoot: root.remoteRoot,
    mode: 'one-way-replica' as const,
    exclusionPolicy: 'explicit-only' as const,
    maxEntryCount: DEVBOX_PASTE_SYNC_MAX_ENTRY_COUNT,
    excludes: pasteSyncExcludes(root)
  }))
}
