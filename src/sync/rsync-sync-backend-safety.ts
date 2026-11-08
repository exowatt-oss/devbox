import { join } from 'node:path'
import type { DevboxSyncCreateRequest } from './devbox-sync-backend'
import { DEVBOX_SYNC_EXCLUSIONS, renderRsyncFilterArguments } from './devbox-sync-exclusions'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'

const BASE_RSYNC_ARGS = [
  '--archive',
  '--hard-links',
  '--sparse',
  '--no-owner',
  '--no-group',
  '--partial',
  '--partial-dir=.rsync-partial',
  '--timeout=120',
  '--compress',
  '--compress-choice=zstd',
  '--protect-args'
] as const

export const operationRejected = (profileId: string, field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { profileId, field } })

export const runnerFailed = (profileId: string): DevboxError =>
  createDevboxError('unknown', { retryable: true, context: { profileId, phase: 'sync' } })

export function validateCreateRequest(request: DevboxSyncCreateRequest, profileId: string): void {
  if (request.profileId !== profileId) {
    throw operationRejected(profileId, 'profile-id')
  }
  if (!request.sessionId || !request.rootClassId) {
    throw operationRejected(profileId, 'session-identity')
  }
  if (!request.localRoot || !request.remoteRoot) {
    throw operationRejected(profileId, 'roots')
  }
  if (request.mode !== 'directional') {
    throw operationRejected(profileId, 'two-way-safe-is-not-supported-by-rsync-fallback')
  }
  if (request.direction !== 'local-to-remote' && request.direction !== 'remote-to-local') {
    throw operationRejected(profileId, 'direction')
  }
}

function filterArgs(request: DevboxSyncCreateRequest): string[] {
  const excludes = request.excludes ?? []
  const patterns =
    request.exclusionPolicy === 'explicit-only'
      ? excludes
      : [...DEVBOX_SYNC_EXCLUSIONS, ...excludes]
  return renderRsyncFilterArguments(patterns)
}

function rootWithTrailingSlash(root: string): string {
  return root.endsWith('/') ? root : `${root}/`
}

export function buildRsyncSyncArguments(
  request: DevboxSyncCreateRequest,
  relativePath?: string
): readonly string[] {
  const sourceRoot =
    request.direction === 'remote-to-local' ? request.remoteRoot : request.localRoot
  const destinationRoot =
    request.direction === 'remote-to-local' ? request.localRoot : request.remoteRoot
  const source = relativePath ? join(sourceRoot, relativePath) : rootWithTrailingSlash(sourceRoot)
  const destination = relativePath ? join(destinationRoot, relativePath) : destinationRoot
  return [...BASE_RSYNC_ARGS, ...filterArgs(request), '--', source, destination]
}
