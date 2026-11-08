import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isGenerationUsable } from './devbox-generation-verification'

export async function recoverGenerationRoot(generationsRoot: string): Promise<void> {
  await mkdir(generationsRoot, { recursive: true, mode: 0o700 })

  const names = await readdir(generationsRoot)
  for (const name of names) {
    const candidate = join(generationsRoot, name)
    const info = await lstat(candidate)
    const isGeneration = name.startsWith('.staging-') || name.startsWith('generation-')

    if (!info.isDirectory() || !isGeneration) {
      continue
    }

    const isStaging = name.startsWith('.staging-')
    const isUsable = await isGenerationUsable(candidate)
    if (isStaging || !isUsable) {
      await rm(candidate, { recursive: true, force: true })
    }
  }
}
