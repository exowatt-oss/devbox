import { isAbsolute } from 'node:path'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import { shellEscape } from '../ssh/shell-escape'

export function resolveDevboxShellCwd(
  remoteRoot: string,
  profileShellDir?: string,
  cwdOverride?: string
): string {
  return validateDevboxShellPath(cwdOverride ?? profileShellDir ?? remoteRoot)
}

export function validateDevboxShellPath(remoteCwd: string): string {
  if (!isAbsolute(remoteCwd) || remoteCwd.includes('\u0000')) {
    throw new Error(`Devbox shell directory must be an absolute remote path: ${remoteCwd}`)
  }
  return remoteCwd
}

export async function ensureDevboxShellDirectory(
  runner: DevboxSshRunner,
  remoteCwd: string
): Promise<void> {
  const validated = validateDevboxShellPath(remoteCwd)
  try {
    await runner.command(`test -d ${shellEscape(validated)}`, 10_000)
  } catch {
    throw new Error(`Devbox shell directory does not exist remotely or is not a directory: ${validated}`)
  }
}
