import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BATCH_SIZE = 256

async function inBatches<T>(
  values: readonly T[],
  action: (value: T, index: number) => Promise<void>
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    await Promise.all(
      values.slice(offset, offset + BATCH_SIZE).map((value, index) => action(value, offset + index))
    )
  }
}

export async function createEntryTree(
  root: string,
  entryCount: number
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1_000 || entryCount % 1_000 !== 0) {
    throw new RangeError('The generated entry fixture needs a positive multiple of 1,000.')
  }

  const directoryCount = entryCount / 1_000
  const filesPerDirectory = 999
  const directories = Array.from({ length: directoryCount }, (_, index) =>
    join(root, `bucket-${String(index).padStart(4, '0')}`)
  )
  await inBatches(directories, async (directory) => {
    await mkdir(directory, { recursive: true })
  })

  const files = directories.flatMap((directory, directoryIndex) =>
    Array.from({ length: filesPerDirectory }, (_, fileIndex) =>
      join(
        directory,
        `entry-${String(directoryIndex * filesPerDirectory + fileIndex).padStart(6, '0')}.txt`
      )
    )
  )
  await inBatches(files, async (file) => {
    await writeFile(file, '')
  })
  return [...directories, ...files]
}

export async function createWorktreeShapedRepos(
  root: string,
  count: number
): Promise<readonly string[]> {
  const repositories = Array.from({ length: count }, (_, index) =>
    join(root, `worktree-${String(index).padStart(3, '0')}`)
  )
  await inBatches(repositories, async (repository, index) => {
    await mkdir(repository, { recursive: true })
    await writeFile(
      join(repository, '.git'),
      `gitdir: ${join(root, 'main', '.git', 'worktrees', `worktree-${index}`)}\n`
    )
    await writeFile(join(repository, 'tracked.ts'), `export const worktree = ${index}\n`)
  })
  return repositories
}
