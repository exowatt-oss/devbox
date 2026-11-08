import { describe, expect, it } from 'vitest'
import {
  isDevboxToolchainLock,
  validateDevboxToolchainLock,
  type DevboxToolchainLockV1
} from './devbox-toolchain-lock'

const lock: DevboxToolchainLockV1 = {
  schemaVersion: 1,
  lockId: 'lock-1',
  immutable: true,
  artifacts: [
    {
      name: 'mutagen',
      version: '0.17.6',
      sha256: 'd'.repeat(64),
      sourceUrl: 'https://downloads.example.test/mutagen-0.17.6.tar.gz',
      platform: 'linux-x64'
    },
    {
      name: 'node',
      version: '22.14.0',
      sha256: 'b'.repeat(64),
      sourceUrl: 'https://downloads.example.test/node-22.14.0.tar.gz',
      platform: 'linux-x64'
    },
    {
      name: 'phi-archive',
      version: '0.1.0',
      sha256: 'a'.repeat(64),
      sourceUrl: 'https://downloads.example.test/phi-0.1.0.tar.gz',
      platform: 'linux-x64'
    },
    {
      name: 'uv',
      version: '0.6.5',
      sha256: 'c'.repeat(64),
      sourceUrl: 'https://downloads.example.test/uv-0.6.5.tar.gz',
      platform: 'linux-x64'
    }
  ]
}

describe('Devbox immutable toolchain lock', () => {
  it('validates and deterministically sorts the required artifacts', () => {
    const result = validateDevboxToolchainLock(lock)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lock.artifacts.map((artifact) => artifact.name)).toEqual([
        'mutagen',
        'node',
        'phi-archive',
        'uv'
      ])
      expect(isDevboxToolchainLock(result.lock)).toBe(true)
    }
  })

  it('rejects latest and URL credentials or query strings', () => {
    expect(
      validateDevboxToolchainLock({
        ...lock,
        artifacts: lock.artifacts.map((artifact) =>
          artifact.name === 'node' ? { ...artifact, version: 'latest' } : artifact
        )
      })
    ).toMatchObject({ ok: false, reason: 'latest' })
    expect(
      validateDevboxToolchainLock({
        ...lock,
        artifacts: lock.artifacts.map((artifact) =>
          artifact.name === 'node'
            ? { ...artifact, sourceUrl: 'https://user:secret@example.test/node.tar.gz' }
            : artifact
        )
      })
    ).toMatchObject({ ok: false, reason: 'source' })
  })

  it('requires all four distinct artifacts and a real SHA-256 digest', () => {
    expect(
      validateDevboxToolchainLock({
        ...lock,
        artifacts: lock.artifacts.slice(0, 3)
      })
    ).toMatchObject({ ok: false, reason: 'malformed' })
    expect(
      validateDevboxToolchainLock({
        ...lock,
        artifacts: lock.artifacts.map((artifact) =>
          artifact.name === 'uv' ? { ...artifact, sha256: 'short' } : artifact
        )
      })
    ).toMatchObject({ ok: false, reason: 'digest' })
  })
})
