import type {
  DevboxSyncBackupHandle,
  DevboxSyncConflict,
  DevboxSyncConflictStore,
  DevboxSyncSessionIdentity,
  DevboxSyncSessionStore
} from '../sync/devbox-sync-backend'
import type { MutagenSyncBackendOptions } from '../sync/mutagen-sync-backend'

export function createStandaloneSyncStores(): {
  sessions: DevboxSyncSessionStore
  conflicts: DevboxSyncConflictStore
  backups: MutagenSyncBackendOptions['backupStore']
} {
  const sessions = new Map<string, DevboxSyncSessionIdentity>()
  const conflicts = new Map<string, DevboxSyncConflict>()
  const backups = new Map<string, DevboxSyncBackupHandle>()
  return {
    sessions: {
      list: () => [...sessions.values()],
      upsert: (session) => sessions.set(session.sessionId, session),
      remove: (session) => sessions.delete(session.sessionId)
    },
    conflicts: {
      list: () => [...conflicts.values()],
      remove: (conflictId) => conflicts.delete(conflictId)
    },
    backups: {
      create: async (conflict) => {
        const handle: DevboxSyncBackupHandle = {
          id: `devbox-backup-${conflict.conflictId}`,
          conflictId: conflict.conflictId,
          localHash: conflict.local.hash,
          remoteHash: conflict.remote.hash,
          createdAt: Date.now()
        }
        backups.set(handle.id, handle)
        return handle
      },
      has: async (handle) => backups.has(handle.id)
    }
  }
}
