import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxPathMapper } from './devbox-path-mapper'
import { aborted, exists, inventory, isPointer, sha, sorted } from './devbox-rsync-inventory'
import { DEVBOX_RSYNC_BASE_OPTIONS, DEVBOX_RSYNC_TRACKED_OPTIONS } from './devbox-rsync-filter'
import type {
  DevboxRsyncSeedDependencies,
  DevboxRsyncSeedOptions,
  DevboxRsyncSeedPlan
} from './devbox-rsync-types'

export type DevboxRsyncBaseline = {
  pairDigest: string
  manifestDigest: string
  trackedPaths?: readonly string[]
}

export async function readDevboxRsyncBaseline(
  path: string
): Promise<DevboxRsyncBaseline | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DevboxRsyncBaseline
  } catch {
    return undefined
  }
}

export async function writeDevboxRsyncFile(
  path: string,
  data: string | Uint8Array,
  dependencies: DevboxRsyncSeedDependencies
): Promise<void> {
  if (dependencies.writeFile) {
    return dependencies.writeFile(path, data)
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}

export async function backupDevboxRsync(
  operationId: string,
  paths: readonly string[],
  dependencies: DevboxRsyncSeedDependencies,
  write: (path: string, data: string | Uint8Array) => Promise<void>
): Promise<string> {
  if (dependencies.backup) {
    return dependencies.backup({ operationId, paths })
  }

  const root = join(dirname(paths[0] ?? tmpdir()), `.devbox-backup-${operationId}`)
  await mkdir(root, { recursive: true })
  for (const path of paths) {
    if (await exists(path)) {
      await cp(path, join(root, sha(path)), {
        recursive: true,
        force: true,
        verbatimSymlinks: true
      })
    }
  }
  await write(join(root, 'manifest.json'), JSON.stringify(paths))
  return root
}

export async function executeDevboxRsync(
  plan: DevboxRsyncSeedPlan,
  options: DevboxRsyncSeedOptions,
  excludes: readonly string[],
  reverse: boolean,
  filterPath: string,
  dependencies: DevboxRsyncSeedDependencies
): Promise<number> {
  aborted(options.signal)
  const source = reverse ? plan.destinationRoot : plan.sourceRoot
  const destination = reverse ? plan.sourceRoot : plan.destinationRoot
  const directionalOptions = reverse
    ? excludes.flatMap((path) => ['--include=*/', `--include=${path}`, '--exclude=*'])
    : excludes.map((path) => `--exclude=${path}`)
  const progressOptions = reverse ? ['--stats'] : ['--stats', '--info=progress2']
  const args = [
    ...DEVBOX_RSYNC_BASE_OPTIONS,
    `--filter=merge ${filterPath}`,
    ...directionalOptions,
    '--human-readable',
    ...progressOptions,
    `${source}/`,
    destination
  ]
  const result = await dependencies.exec({
    command: 'rsync',
    args,
    signal: options.signal
  })

  if (result.exitCode !== 0) {
    throw createDevboxError('unknown', {
      retryable: true,
      context: { field: 'rsync' }
    })
  }
  return 1
}

export async function executeDevboxTrackedRsync(
  plan: DevboxRsyncSeedPlan,
  list: string,
  options: DevboxRsyncSeedOptions,
  dependencies: DevboxRsyncSeedDependencies
): Promise<number> {
  const args = [
    ...DEVBOX_RSYNC_TRACKED_OPTIONS,
    '--ignore-missing-args',
    '--from0',
    `--files-from=${list}`,
    '--human-readable',
    '--stats',
    `${plan.sourceRoot}/`,
    plan.destinationRoot
  ]
  const result = await dependencies.exec({
    command: 'rsync',
    args,
    signal: options.signal
  })

  if (result.exitCode !== 0) {
    throw createDevboxError('unknown', {
      retryable: true,
      context: { field: 'rsync-tracked' }
    })
  }
  return 1
}

export async function relocateDevboxRsyncPaths(
  profile: DevboxProfileV1,
  root: string,
  direction: 'local-to-remote' | 'remote-to-local',
  signal?: AbortSignal,
  apply = true
): Promise<void> {
  const mapper = new DevboxPathMapper(profile)
  const entries = await inventory(root, signal)
  const symlinks = entries.filter((entry) => entry.kind === 'symlink')
  const pointers = entries.filter((entry) => entry.kind === 'file' && isPointer(entry.relativePath))

  for (const entry of symlinks) {
    aborted(signal)
    const path = join(root, entry.relativePath)
    const target = entry.target!
    const mapped = mapper.relocateSymlinkTarget(target, direction, { symlinkPath: path })
    if (mapped.status === 'out-of-root' || mapped.status === 'invalid') {
      throw mapped.error
    }
    if (mapped.status === 'absolute-in-root' && mapped.relocatedTarget !== target && apply) {
      await replaceSymlink(path, mapped.relocatedTarget)
    }
  }

  for (const entry of pointers) {
    aborted(signal)
    const path = join(root, entry.relativePath)
    const content = await readFile(path, 'utf8')

    if (basename(entry.relativePath) === 'gitdir' && !content.startsWith('gitdir:')) {
      const ending = content.endsWith('\r\n') ? '\r\n' : content.endsWith('\n') ? '\n' : ''
      const target = ending ? content.slice(0, -ending.length) : content
      const mapped = mapper.relocateSymlinkTarget(target, direction)
      if (mapped.status === 'out-of-root' || mapped.status === 'invalid') {
        throw mapped.error
      }
      if (mapped.status === 'absolute-in-root' && apply) {
        await replaceFile(path, `${mapped.relocatedTarget}${ending}`)
      }
      continue
    }

    const mapped = mapper.relocateGitWorktreePointer(content, direction)
    if (mapped.status === 'out-of-root' || mapped.status === 'invalid') {
      throw mapped.error
    }
    if (mapped.status === 'absolute-in-root' && mapped.relocatedContent !== content && apply) {
      await replaceFile(path, mapped.relocatedContent)
    }
  }
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  const temp = `${path}.devbox-link-${randomUUID()}`
  await symlink(target, temp)
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function replaceFile(path: string, content: string): Promise<void> {
  const temp = `${path}.devbox-pointer-${randomUUID()}`
  await writeFile(temp, content)
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

export async function collectDevboxTrackedFiles(
  root: string,
  deps: Pick<DevboxRsyncSeedDependencies, 'exec'>,
  signal?: AbortSignal
): Promise<readonly string[]> {
  const repositories: string[] = []

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

    if (children.some((child) => child.name === '.git')) {
      repositories.push(directory)
    }

    for (const child of children) {
      if (child.isDirectory() && !child.isSymbolicLink() && child.name !== '.git') {
        await walk(join(directory, child.name))
      }
    }
  }

  await walk(root)

  const paths = new Set<string>()
  for (const repository of sorted(repositories, (path) => path)) {
    const result = await deps.exec({
      command: 'git',
      args: ['-C', repository, 'ls-files', '-z'],
      signal
    })

    if (result.exitCode !== 0) {
      throw createDevboxError('unknown', {
        context: { field: 'git-ls-files' }
      })
    }

    for (const value of result.stdout.split('\0')) {
      if (!value) {
        continue
      }

      const absolute = join(repository, value)
      const relativePath = relative(root, absolute).replaceAll('\\', '/')
      if (await exists(absolute)) {
        paths.add(relativePath)
      }
    }
  }

  return [...paths].sort((a, b) => a.localeCompare(b))
}
