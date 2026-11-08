import { chmod, copyFile, lstat, mkdir, readlink, readdir, symlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'

const invalid = (field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { field } })

export async function copyTree(source: string, target: string): Promise<void> {
  const info = await lstat(source)

  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }

  if (info.isDirectory()) {
    await mkdir(target, { recursive: false, mode: info.mode & 0o7777 })
    const children = await readdir(source)
    for (const child of children) {
      await copyTree(join(source, child), join(target, child))
    }
    await chmod(target, info.mode & 0o7777)
    return
  }

  if (!info.isFile()) {
    throw invalid('unsupported-entry')
  }

  try {
    await copyFile(source, target, fsConstants.COPYFILE_FICLONE)
  } catch {
    await copyFile(source, target)
  }
  await chmod(target, info.mode & 0o7777)
}
