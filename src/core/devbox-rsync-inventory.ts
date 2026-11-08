import { createHash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { lstat, readlink, readdir } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { Dirent } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import { filterMatches } from './devbox-rsync-filter'
import type {
  DevboxAdoptionClassification,
  DevboxAdoptionComparison,
  DevboxRsyncEntryKind,
  DevboxRsyncInventoryEntry
} from './devbox-rsync-types'

export const sha = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

export const DEVBOX_RSYNC_HASH_CHUNK_BYTES = 64 * 1024

const inventoryHashError = (path: string) =>
  createDevboxError('unknown', {
    retryable: true,
    context: { field: `inventory-hash:${path}` }
  })

const sameFileSnapshot = (before: Stats, after: Stats): boolean =>
  after.isFile() &&
  after.size === before.size &&
  after.dev === before.dev &&
  after.ino === before.ino

async function hashFile(path: string, before: Stats, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  try {
    await pipeline(
      createReadStream(path, {
        highWaterMark: DEVBOX_RSYNC_HASH_CHUNK_BYTES,
        signal
      }),
      hash,
      { signal }
    )
    aborted(signal)
    // Why: an open descriptor can survive unlink/truncate races; verify the path afterward.
    const after = await lstat(path)
    if (!sameFileSnapshot(before, after)) {
      throw new Error('file changed while hashing')
    }
    return hash.digest('hex')
  } catch {
    if (signal?.aborted) {
      throw createDevboxError('cancelled')
    }
    throw inventoryHashError(path)
  }
}

export const aborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createDevboxError('cancelled')
  }
}

export const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((a, b) => key(a).localeCompare(key(b)))

export const exists = async (path: string): Promise<boolean> =>
  lstat(path)
    .then(() => true)
    .catch(() => false)

export const isPointer = (path: string): boolean =>
  basename(path) === '.git' || (path.includes('/.git/worktrees/') && basename(path) === 'gitdir')

export async function inventory(
  root: string,
  signal?: AbortSignal,
  skip?: string
): Promise<DevboxRsyncInventoryEntry[]> {
  const output: DevboxRsyncInventoryEntry[] = []

  const walk = async (directory: string): Promise<void> => {
    aborted(signal)

    let children: Dirent<string>[]
    try {
      children = await readdir(directory, {
        withFileTypes: true,
        encoding: 'utf8'
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const child of children) {
      const absolute = join(directory, child.name)
      const path = relative(root, absolute).replaceAll('\\', '/')
      const info = await lstat(absolute)

      if (path === skip) {
        continue
      }

      const kind: DevboxRsyncEntryKind = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'directory'
          : info.isSymbolicLink()
            ? 'symlink'
            : info.isFIFO()
              ? 'fifo'
              : info.isSocket()
                ? 'socket'
                : info.isCharacterDevice() || info.isBlockDevice()
                  ? 'device'
                  : 'unknown'
      const target = kind === 'symlink' ? await readlink(absolute) : undefined
      const digest =
        kind === 'file'
          ? await hashFile(absolute, info, signal)
          : kind === 'symlink'
            ? sha(`symlink\0${target}`)
            : sha(kind)

      output.push({
        relativePath: path,
        kind,
        size: kind === 'file' ? info.size : 0,
        sha256: digest,
        ...(target === undefined ? {} : { target })
      })

      if (kind === 'directory') {
        await walk(absolute)
      }
    }
  }

  await walk(root)
  return sorted(output, (entry) => entry.relativePath)
}

export const compareEntries = (
  local: readonly DevboxRsyncInventoryEntry[],
  remote: readonly DevboxRsyncInventoryEntry[]
): DevboxAdoptionComparison[] => {
  const left = new Map(local.map((entry) => [entry.relativePath, entry]))
  const right = new Map(remote.map((entry) => [entry.relativePath, entry]))
  const paths = [...new Set([...left.keys(), ...right.keys()])]

  return sorted(paths, (path) => path).map((relativePath) => {
    const localEntry = left.get(relativePath)
    const remoteEntry = right.get(relativePath)
    const classification: DevboxAdoptionClassification = !localEntry
      ? 'remote-only'
      : !remoteEntry
        ? 'local-only'
        : localEntry.kind !== remoteEntry.kind
          ? 'type-conflict'
          : localEntry.sha256 === remoteEntry.sha256 && localEntry.target === remoteEntry.target
            ? 'identical'
            : 'divergent-same-path'

    return {
      relativePath,
      classification,
      ...(localEntry ? { local: localEntry } : {}),
      ...(remoteEntry ? { remote: remoteEntry } : {})
    }
  })
}

export const digestPlan = (comparisons: readonly DevboxAdoptionComparison[]): string =>
  sha(
    JSON.stringify(
      comparisons.map((item) => [
        item.relativePath,
        item.classification,
        item.local?.sha256,
        item.remote?.sha256,
        item.local?.target,
        item.remote?.target
      ])
    )
  )

export { filterMatches }
export { inventory as inventoryDevboxRsyncEntries }
