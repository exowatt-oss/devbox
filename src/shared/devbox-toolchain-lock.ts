export const DEVBOX_TOOLCHAIN_LOCK_SCHEMA_VERSION = 1 as const
export const DEVBOX_TOOLCHAIN_ARTIFACT_NAMES = ['phi-archive', 'node', 'uv', 'mutagen'] as const

export type DevboxToolchainArtifactName = (typeof DEVBOX_TOOLCHAIN_ARTIFACT_NAMES)[number]

export type DevboxToolchainPlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-arm64'
  | 'win32-x64'

export type DevboxToolchainArtifact = {
  name: DevboxToolchainArtifactName
  version: string
  sha256: string
  sourceUrl: string
  platform: DevboxToolchainPlatform
}

/** `immutable: true` is intentionally literal; there is no mutable/latest lock form. */
export type DevboxToolchainLockV1 = {
  schemaVersion: typeof DEVBOX_TOOLCHAIN_LOCK_SCHEMA_VERSION
  lockId: string
  immutable: true
  artifacts: readonly DevboxToolchainArtifact[]
}

export type DevboxToolchainLockValidationResult =
  | { ok: true; lock: DevboxToolchainLockV1 }
  | { ok: false; reason: 'malformed' | 'latest' | 'digest' | 'source'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())
}

function isArtifactName(value: unknown): value is DevboxToolchainArtifactName {
  return value === 'phi-archive' || value === 'node' || value === 'uv' || value === 'mutagen'
}

function isPlatform(value: unknown): value is DevboxToolchainPlatform {
  return (
    value === 'darwin-arm64' ||
    value === 'darwin-x64' ||
    value === 'linux-arm64' ||
    value === 'linux-x64' ||
    value === 'win32-arm64' ||
    value === 'win32-x64'
  )
}

function isPinnedVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== 'latest' &&
    !value.trim().toLowerCase().includes('latest')
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function isPinnedSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

export function validateDevboxToolchainLock(input: unknown): DevboxToolchainLockValidationResult {
  if (!isRecord(input)) {
    return { ok: false, reason: 'malformed', message: 'Toolchain lock must be an object.' }
  }
  if (input.schemaVersion !== DEVBOX_TOOLCHAIN_LOCK_SCHEMA_VERSION || input.immutable !== true) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Toolchain lock schema or immutable marker is invalid.'
    }
  }
  if (!isSafeId(input.lockId) || !Array.isArray(input.artifacts)) {
    return { ok: false, reason: 'malformed', message: 'Toolchain lock identity is invalid.' }
  }
  const artifacts = input.artifacts
  if (artifacts.length !== DEVBOX_TOOLCHAIN_ARTIFACT_NAMES.length) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Toolchain lock must contain exactly Phi, Node, uv, and Mutagen.'
    }
  }
  const names = new Set<DevboxToolchainArtifactName>()
  const normalized: DevboxToolchainArtifact[] = []
  for (const candidate of artifacts) {
    if (!isRecord(candidate) || !isArtifactName(candidate.name) || names.has(candidate.name)) {
      return { ok: false, reason: 'malformed', message: 'Toolchain artifact identity is invalid.' }
    }
    if (!isPinnedVersion(candidate.version)) {
      return {
        ok: false,
        reason: 'latest',
        message: 'Toolchain artifacts must use explicit immutable versions.'
      }
    }
    if (!isSha256(candidate.sha256)) {
      return {
        ok: false,
        reason: 'digest',
        message: 'Toolchain artifacts must use a SHA-256 digest.'
      }
    }
    if (!isPinnedSourceUrl(candidate.sourceUrl)) {
      return {
        ok: false,
        reason: 'source',
        message: 'Toolchain artifact source URLs must be pinned HTTPS URLs without credentials.'
      }
    }
    if (!isPlatform(candidate.platform)) {
      return { ok: false, reason: 'malformed', message: 'Toolchain artifact platform is invalid.' }
    }
    names.add(candidate.name)
    normalized.push({
      name: candidate.name,
      version: candidate.version.trim(),
      sha256: candidate.sha256.toLowerCase(),
      sourceUrl: candidate.sourceUrl,
      platform: candidate.platform
    })
  }
  if (DEVBOX_TOOLCHAIN_ARTIFACT_NAMES.some((name) => !names.has(name))) {
    return { ok: false, reason: 'malformed', message: 'Toolchain lock is missing an artifact.' }
  }
  normalized.sort((a, b) => a.name.localeCompare(b.name))
  return {
    ok: true,
    lock: {
      schemaVersion: DEVBOX_TOOLCHAIN_LOCK_SCHEMA_VERSION,
      lockId: input.lockId.trim(),
      immutable: true,
      artifacts: normalized
    }
  }
}

export function isDevboxToolchainLock(input: unknown): input is DevboxToolchainLockV1 {
  return validateDevboxToolchainLock(input).ok
}
