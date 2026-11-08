import {
  validateDevboxToolchainLock,
  type DevboxToolchainLockV1,
  type DevboxToolchainPlatform
} from '../shared/devbox-toolchain-lock'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'

export const MUTAGEN_VERSION = '0.18.1' as const
export const MUTAGEN_RELEASE_TAG = `v${MUTAGEN_VERSION}` as const
export const MUTAGEN_RELEASE_VERIFICATION_SOURCES = Object.freeze([
  'https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS',
  'https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS.gpg'
] as const)

export type MutagenReleasePlatform = 'darwin_arm64' | 'darwin_amd64' | 'linux_amd64'

type MutagenReleasePin = {
  version: typeof MUTAGEN_VERSION
  assetName: string
  sha256: string
  sourceUrl: string
  lockPlatform: DevboxToolchainPlatform
}

const RELEASE_BASE_URL = 'https://github.com/mutagen-io/mutagen/releases/download/v0.18.1' as const

/**
 * These values were derived on 2026-08-30 by downloading the official
 * `https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS`
 * manifest and matching the three supported asset filenames. The detached
 * SHA256SUMS.gpg signature is the release-verification source; the signature key
 * trust decision remains an explicit release-policy input.
 */
export const MUTAGEN_RELEASE_PINS: Readonly<Record<MutagenReleasePlatform, MutagenReleasePin>> =
  Object.freeze({
    darwin_arm64: Object.freeze({
      version: MUTAGEN_VERSION,
      assetName: 'mutagen_darwin_arm64_v0.18.1.tar.gz',
      sha256: '6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2',
      sourceUrl: `${RELEASE_BASE_URL}/mutagen_darwin_arm64_v0.18.1.tar.gz`,
      lockPlatform: 'darwin-arm64'
    }),
    darwin_amd64: Object.freeze({
      version: MUTAGEN_VERSION,
      assetName: 'mutagen_darwin_amd64_v0.18.1.tar.gz',
      sha256: '7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf',
      sourceUrl: `${RELEASE_BASE_URL}/mutagen_darwin_amd64_v0.18.1.tar.gz`,
      lockPlatform: 'darwin-x64'
    }),
    linux_amd64: Object.freeze({
      version: MUTAGEN_VERSION,
      assetName: 'mutagen_linux_amd64_v0.18.1.tar.gz',
      sha256: '7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f',
      sourceUrl: `${RELEASE_BASE_URL}/mutagen_linux_amd64_v0.18.1.tar.gz`,
      lockPlatform: 'linux-x64'
    })
  })

export function validateMutagenReleaseLock(
  lock: unknown,
  platform: MutagenReleasePlatform
): DevboxError | null {
  const validation = validateDevboxToolchainLock(lock)
  if (!validation.ok) {
    return createDevboxError(
      validation.reason === 'digest' ? 'toolchain_digest_invalid' : 'toolchain_invalid',
      { context: { field: `mutagen-lock-${validation.reason}` } }
    )
  }
  const pin = MUTAGEN_RELEASE_PINS[platform]
  const artifact = validation.lock.artifacts.find((candidate) => candidate.name === 'mutagen')
  if (
    !artifact ||
    artifact.version !== pin.version ||
    artifact.platform !== pin.lockPlatform ||
    artifact.sha256.toLowerCase() !== pin.sha256 ||
    artifact.sourceUrl !== pin.sourceUrl
  ) {
    return createDevboxError('toolchain_digest_invalid', {
      context: { field: `mutagen-release-${platform}` }
    })
  }
  return null
}

export function assertMutagenReleaseLock(
  lock: unknown,
  platform: MutagenReleasePlatform
): asserts lock is DevboxToolchainLockV1 {
  const error = validateMutagenReleaseLock(lock, platform)
  if (error) {
    throw error
  }
}
