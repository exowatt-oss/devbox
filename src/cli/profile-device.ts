import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxProfileStore } from '../core/devbox-profile-store'

const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export type DevboxProfileDeviceResult = {
  profileId: string
  device: string | null
}

export function setDevboxProfileDevice(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  device: string | undefined
): DevboxProfileDeviceResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = loadProfile(store, profileId)
  const normalized = device?.trim()
  if (normalized !== undefined && !DEVICE_PATTERN.test(normalized)) {
    throw createDevboxError('operation_conflict', {
      message: 'Device alias must start with a letter or number and contain only letters, numbers, ., _, or -.',
      context: { field: 'device' }
    })
  }
  if (normalized !== undefined) {
    const collision = store.listProfiles().find((candidate) =>
      candidate.id !== loaded.id && (candidate.id === normalized || candidate.device === normalized)
    )
    if (collision) {
      throw createDevboxError('operation_conflict', {
        message: `Device alias "${normalized}" collides with profile ${collision.id}.`,
        context: { field: 'device-collision', profileId: loaded.id }
      })
    }
  }
  const next = { ...loaded }
  if (normalized === undefined) {
    delete next.device
  } else {
    next.device = normalized
  }
  const saved = store.saveProfile(next)
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed', { context: { profileId } })
  }
  return { profileId: saved.profile.id, device: saved.profile.device ?? null }
}

export function showDevboxProfileDevice(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileDeviceResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = loadProfile(store, profileId)
  return { profileId: loaded.id, device: loaded.device ?? null }
}

function loadProfile(store: DevboxProfileStore, profileId: string): DevboxProfileV1 {
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  return loaded.profile
}
