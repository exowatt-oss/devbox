import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeSecureFile } from './secure-file'

describe('writeSecureFile', () => {
  it('creates private parent directories and a mode 600 file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-secure-file-'))
    const target = join(root, 'nested', 'known_hosts')
    try {
      writeSecureFile(target, 'secret\n')

      expect(await readFile(target, 'utf8')).toBe('secret\n')
      if (process.platform !== 'win32') {
        expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700)
        expect((await stat(target)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
