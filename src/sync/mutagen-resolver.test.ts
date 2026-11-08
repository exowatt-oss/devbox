import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { MUTAGEN_VERSION } from './mutagen-release-pins'
import { mutagenManagedBinaryPath, resolveMutagenBinary } from './mutagen-resolver'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'devbox-mutagen-resolver-'))
}

function executable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
}

describe('Mutagen binary resolver', () => {
  it('uses DEVBOX_MUTAGEN_BINARY before every automatic source', async () => {
    await expect(resolveMutagenBinary({
      env: { DEVBOX_MUTAGEN_BINARY: '/custom/mutagen', HOME: home(), PATH: '' }
    })).resolves.toBe('/custom/mutagen')
  })

  it('uses the Devbox-managed cache before PATH and extracted opt installs', async () => {
    const root = home()
    const managed = mutagenManagedBinaryPath(root)
    executable(managed)
    const runVersion = vi.fn(async () => 'Mutagen version 0.18.1')
    await expect(resolveMutagenBinary({
      env: { HOME: root, PATH: '/unused' },
      runVersion
    })).resolves.toBe(managed)
    expect(runVersion).not.toHaveBeenCalled()
  })

  it('accepts PATH Mutagen only when version is 0.18.x', async () => {
    const root = home()
    const pathBinary = join(root, 'bin', 'mutagen')
    executable(pathBinary)
    const runVersion = vi.fn(async () => 'Mutagen version 0.18.9')
    await expect(resolveMutagenBinary({
      env: { HOME: root, PATH: join(root, 'bin') },
      runVersion
    })).resolves.toBe(pathBinary)
    expect(runVersion).toHaveBeenCalledWith(pathBinary, { HOME: root, PATH: join(root, 'bin') })
  })

  it('uses sample’s extracted opt layout after rejecting an incompatible PATH version', async () => {
    const root = home()
    const pathBinary = join(root, 'bin', 'mutagen')
    const extracted = join(root, '.local', 'opt', 'mutagen-0.18.1', 'extracted', 'mutagen')
    executable(pathBinary)
    executable(extracted)
    await expect(resolveMutagenBinary({
      env: { HOME: root, PATH: join(root, 'bin') },
      runVersion: async () => 'Mutagen version 0.17.0'
    })).resolves.toBe(extracted)
  })

  it('auto-installs once through an empty-environment Mac invocation and caches forever', async () => {
    const root = home()
    const download = vi.fn(async () => new Uint8Array(Buffer.from('fixture-archive')))
    const extract = vi.fn(async (_archive: string, destination: string) => {
      const binary = join(destination, 'mutagen')
      executable(binary)
      return binary
    })
    const log = vi.fn()
    const options = {
      env: { HOME: root, PATH: '' },
      platform: 'darwin' as const,
      arch: 'arm64',
      download,
      extract,
      sha256: () => '6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2',
      log
    }
    const first = await resolveMutagenBinary(options)
    const second = await resolveMutagenBinary(options)
    expect(first).toBe(mutagenManagedBinaryPath(root))
    expect(second).toBe(first)
    expect(download).toHaveBeenCalledOnce()
    expect(extract).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toContain(`installing Mutagen ${MUTAGEN_VERSION}`)
  })
})
