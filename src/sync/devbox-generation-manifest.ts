import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type {
  DevboxWorkspaceManifest,
  DevboxWorkspaceManifestEntry
} from './devbox-workspace-generation-manager'

export const MANIFEST_FILE = '.devbox-generation-manifest.json'
export const READY_FILE = '.devbox-generation-ready'
export const LEASE_DIR = '.devbox-generation-leases'

const invalid = (field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { field } })

export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const isWithinRoot = (root: string, candidate: string): boolean => {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function walk(
  root: string,
  current: string,
  entries: DevboxWorkspaceManifestEntry[],
  ignoreManaged = false
): Promise<void> {
  const info = await lstat(current)
  const path = relative(root, current)
  const isManagedEntry =
    path === MANIFEST_FILE ||
    path === READY_FILE ||
    path === LEASE_DIR ||
    path.startsWith(`${LEASE_DIR}${sep}`)

  if (ignoreManaged && isManagedEntry) {
    return
  }

  if (info.isSymbolicLink()) {
    const target = await readlink(current)
    const resolvedTarget = resolve(current, '..', target)
    if (isAbsolute(target) || !isWithinRoot(root, resolvedTarget)) {
      throw invalid('symlink-escape')
    }
    entries.push({
      path,
      kind: 'symlink',
      hash: digest(target),
      mode: info.mode,
      target
    })
    return
  }

  if (info.isDirectory()) {
    if (path) {
      entries.push({ path, kind: 'directory', hash: '', mode: info.mode })
    }
    const children = (await readdir(current)).sort()
    for (const child of children) {
      await walk(root, join(current, child), entries, ignoreManaged)
    }
    return
  }

  if (!info.isFile()) {
    throw invalid('unsupported-entry')
  }

  entries.push({
    path,
    kind: 'file',
    hash: digest(await readFile(current)),
    mode: info.mode,
    size: info.size
  })
}

export async function createManifest(
  root: string,
  now: number,
  ignoreManaged = false
): Promise<DevboxWorkspaceManifest> {
  const entries: DevboxWorkspaceManifestEntry[] = []
  await walk(root, root, entries, ignoreManaged)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    schemaVersion: 1,
    sourceRoot: root,
    createdAt: now,
    entries,
    treeHash: digest(entries)
  }
}

export async function readManifest(root: string): Promise<DevboxWorkspaceManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'))
    const schemaVersion =
      value && typeof value === 'object'
        ? (value as { schemaVersion?: unknown }).schemaVersion
        : undefined
    return schemaVersion === 1 ? (value as DevboxWorkspaceManifest) : null
  } catch {
    return null
  }
}
