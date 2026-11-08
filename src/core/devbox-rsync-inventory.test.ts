import { truncateSync, unlinkSync } from 'node:fs'
import type { ReadStream } from 'node:fs'
import type * as Fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEVBOX_RSYNC_HASH_CHUNK_BYTES, inventory, sha } from './devbox-rsync-inventory'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devbox-inventory-'))
  return { root, cleanup: () => rm(root, { force: true, recursive: true }) }
}

async function loadInventoryWithStreamHook(hook: (path: string, stream: ReadStream) => void) {
  vi.resetModules()
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof Fs>('node:fs')
    const createReadStream = ((path: string) => {
      const stream = actual.createReadStream(path)
      hook(path, stream)
      return stream
    }) as typeof actual.createReadStream
    return { ...actual, createReadStream }
  })
  return import('./devbox-rsync-inventory')
}

describe('Devbox rsync inventory hashing', () => {
  it('matches buffered SHA-256 for empty and exact-chunk-size files', async () => {
    const f = await fixture()
    try {
      const contents = new Map([
        ['empty.bin', Buffer.alloc(0)],
        [
          'exact-chunks.bin',
          Buffer.from(
            Array.from({ length: DEVBOX_RSYNC_HASH_CHUNK_BYTES * 2 }, (_, index) => index % 251)
          )
        ]
      ])
      for (const [name, bytes] of contents) {
        await writeFile(join(f.root, name), bytes)
      }

      const entries = await inventory(f.root)
      for (const [name, bytes] of contents) {
        const entry = entries.find((candidate) => candidate.relativePath === name)
        expect(entry?.sha256).toBe(sha(bytes))
        expect(entry?.size).toBe(bytes.byteLength)
      }
    } finally {
      await f.cleanup()
    }
  })

  it.each([
    [
      'deleted',
      (path: string, stream: ReadStream) => {
        stream.once('data', () => unlinkSync(path))
      }
    ],
    [
      'truncated',
      (path: string, stream: ReadStream) => {
        stream.once('data', () => truncateSync(path, 0))
      }
    ],
    [
      'read error',
      (_path: string, stream: ReadStream) => {
        stream.once('data', () => stream.destroy(new Error('fixture read failure')))
      }
    ]
  ])('returns a typed error when a file is %s while hashing', async (_failure, mutate) => {
    const f = await fixture()
    const path = join(f.root, 'changing.bin')
    try {
      await writeFile(path, Buffer.alloc(DEVBOX_RSYNC_HASH_CHUNK_BYTES * 2, 7))
      const imported = await loadInventoryWithStreamHook((streamPath, stream) => {
        if (streamPath === path) {
          mutate(streamPath, stream)
        }
      })
      await expect(imported.inventory(f.root)).rejects.toMatchObject({
        code: 'unknown',
        retryable: true
      })
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
      await f.cleanup()
    }
  })
})
