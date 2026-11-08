import { truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createScaleRoots } from './fixture-profile'

const LARGE_FILE_BYTES = 64 * 1024 * 1024

describe('Devbox large-file fixtures', () => {
  it('streams large-file hashing instead of reading the whole file at once', async () => {
    const fixture = await createScaleRoots('devbox-large-file-')
    try {
      const largeFile = join(fixture.local, 'large-artifact.bin')
      await writeFile(largeFile, '')
      await truncate(largeFile, LARGE_FILE_BYTES)
      vi.resetModules()
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<Record<string, unknown>>('node:fs/promises')
        return {
          ...actual,
          readFile: async () => {
            throw new Error('large-file fixture observed a whole-file read')
          }
        }
      })

      const { inventory } = await import('../../core/devbox-rsync-inventory')
      await expect(inventory(fixture.local)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: 'large-artifact.bin',
            size: LARGE_FILE_BYTES
          })
        ])
      )
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
      await fixture.cleanup()
    }
  }, 30_000)

  it.skip('SKIPPED: external Mutagen large-file transport requires a Mutagen binary and a real OpenSSH host', () =>
    undefined)
})
