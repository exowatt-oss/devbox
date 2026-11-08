import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxSyncBackend, DevboxSyncCreateRequest } from './devbox-sync-backend'
import type { BackendFactory, DevboxSyncSupervisorOptions } from './devbox-sync-supervisor-contract'

export type BackendSelection = {
  factory: BackendFactory
  request: DevboxSyncCreateRequest
  mutagen: boolean
  fallbackDegradation?: 'mutagen-unavailable' | 'mutagen-unapproved' | 'mutagen-error'
}

async function readToggle(
  value: boolean | (() => boolean | Promise<boolean>) | undefined,
  fallback: boolean
): Promise<boolean> {
  if (value === undefined) {
    return fallback
  }
  if (typeof value === 'function') {
    return await value()
  }
  return value
}

export async function selectBackend(
  options: DevboxSyncSupervisorOptions,
  profileId: string,
  request: DevboxSyncCreateRequest
): Promise<BackendSelection> {
  if (options.backendFactory) {
    return {
      factory: options.backendFactory,
      request,
      mutagen: false
    }
  }
  const available = await readToggle(options.mutagenAvailable, true)
  const approved = await readToggle(options.mutagenApproved, true)
  if (available && approved && options.mutagenBackendFactory) {
    return {
      factory: options.mutagenBackendFactory,
      request,
      mutagen: true
    }
  }
  if (!options.rsyncBackendFactory) {
    throw createDevboxError('operation_conflict', {
      context: {
        profileId,
        field: available ? 'mutagen-unapproved' : 'mutagen-unavailable'
      }
    })
  }
  const fallbackDegradation = !options.mutagenBackendFactory
    ? 'mutagen-unavailable'
    : available
      ? 'mutagen-unapproved'
      : 'mutagen-unavailable'
  return {
    factory: options.rsyncBackendFactory,
    request: {
      ...request,
      mode: 'directional',
      direction: request.direction ?? options.fallbackDirection ?? 'local-to-remote'
    },
    mutagen: false,
    fallbackDegradation
  }
}

export async function createObservationBackend(
  options: DevboxSyncSupervisorOptions,
  profileId: string,
  request: DevboxSyncCreateRequest
): Promise<{
  backend: DevboxSyncBackend
  fallbackDegradation?: BackendSelection['fallbackDegradation']
}> {
  const selected = await selectBackend(options, profileId, request)
  return {
    backend: await selected.factory(selected.request),
    fallbackDegradation: selected.fallbackDegradation
  }
}

export async function createBackend(
  options: DevboxSyncSupervisorOptions,
  profileId: string,
  request: DevboxSyncCreateRequest
): Promise<{
  backend: DevboxSyncBackend
  fallbackDegradation?: BackendSelection['fallbackDegradation']
}> {
  const selected = await selectBackend(options, profileId, request)
  let backend: DevboxSyncBackend
  try {
    backend = await selected.factory(selected.request)
    await backend.create(selected.request)
  } catch (error) {
    if (!selected.mutagen || !options.rsyncBackendFactory) {
      throw error
    }
    const fallbackRequest = {
      ...request,
      mode: 'directional' as const,
      direction: request.direction ?? options.fallbackDirection ?? ('local-to-remote' as const)
    }
    backend = await options.rsyncBackendFactory(fallbackRequest)
    await backend.create(fallbackRequest)
    return { backend, fallbackDegradation: 'mutagen-error' }
  }
  return { backend, fallbackDegradation: selected.fallbackDegradation }
}
