import { isAbsolute, resolve } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import { assertMutagenReleaseLock } from './mutagen-release-pins'
import type { MutagenCli, MutagenUpgradeOptions } from './mutagen-cli'

export async function upgradeMutagen(
  cli: MutagenCli,
  profileId: string,
  options: MutagenUpgradeOptions,
  signal: AbortSignal | undefined,
  setBinaryPath: (binaryPath: string) => void
): Promise<void> {
  assertMutagenReleaseLock(options.lock, options.platform)
  if (
    !isAbsolute(options.newBinaryPath) ||
    options.newBinaryPath !== resolve(options.newBinaryPath)
  ) {
    throw createDevboxError('operation_conflict', {
      context: { profileId, field: 'new-mutagen-binary-path' }
    })
  }
  const sessions = await cli.listSessions(signal)
  for (const session of sessions) {
    await cli.flush(session.identifier, signal)
  }
  for (const session of sessions) {
    await cli.pause(session.identifier, signal)
  }
  await cli.daemonStop(signal)
  const snapshot = await options.snapshotDataDirectory()
  const previousBinary = cli.currentBinaryPath
  try {
    await options.installBinary?.(options.newBinaryPath)
    setBinaryPath(options.newBinaryPath)
    await cli.daemonStart(signal)
    await options.recreateAndVerify(cli)
  } catch (error) {
    setBinaryPath(previousBinary)
    await cli.daemonStop(signal).catch(() => undefined)
    await options.restoreDataDirectory(snapshot)
    await options.restoreBinary?.()
    await cli.daemonStart(signal).catch(() => undefined)
    throw error
  }
}
