import type { DevboxSyncFreshness } from './devbox-sync-backend'

export function syncFreshness(
  lastSynchronizedAt: number | null,
  lastAttemptFailed: boolean,
  conflictCount: number
): DevboxSyncFreshness {
  if (lastSynchronizedAt === null) {
    return 'unknown'
  }
  return lastAttemptFailed || conflictCount > 0 ? 'stale' : 'fresh'
}
