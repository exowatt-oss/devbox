import {
  DEVBOX_MUTAGEN_MODES,
  type DevboxSyncCreateRequest
} from './devbox-sync-backend'

export function isValidMutagenSyncCreateRequest(
  profileId: string,
  request: DevboxSyncCreateRequest
): boolean {
  return (
    request.profileId === profileId &&
    Boolean(request.sessionId) &&
    Boolean(request.rootClassId) &&
    Boolean(request.localRoot) &&
    Boolean(request.remoteRoot) &&
    DEVBOX_MUTAGEN_MODES.has(request.mode) &&
    request.direction === undefined &&
    (request.watchPollingIntervalSeconds === undefined ||
      (Number.isSafeInteger(request.watchPollingIntervalSeconds) && request.watchPollingIntervalSeconds >= 1))
  )
}
