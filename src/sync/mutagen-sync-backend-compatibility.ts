import { MUTAGEN_POLLING_INTERVAL_SECONDS } from './mutagen-cli-types'
import type { DevboxSyncCreateRequest } from './devbox-sync-backend'
import type { MutagenSessionRecord } from './mutagen-cli'

export type MutagenPollingIntervalCompatibility =
  | 'watch-polling-interval-mismatch'
  | 'watch-polling-interval-unverified'
  | null

export function pollingIntervalCompatibility(
  session: MutagenSessionRecord,
  request: DevboxSyncCreateRequest
): MutagenPollingIntervalCompatibility {
  const expected = request.watchPollingIntervalSeconds ?? MUTAGEN_POLLING_INTERVAL_SECONDS
  if (session.watch.pollingInterval === null) {
    return 'watch-polling-interval-unverified'
  }
  return session.watch.pollingInterval === expected ? null : 'watch-polling-interval-mismatch'
}
