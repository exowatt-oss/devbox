import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import { runnerFailed } from './rsync-sync-backend-safety'
import type { RsyncCommandResult, RsyncCommandRunner } from './rsync-sync-backend-lifecycle'

function classifyRsyncFailure(profileId: string, result: RsyncCommandResult): DevboxError {
  const output = `${result.stdout}\n${result.stderr}`
  if (result.exitCode === 28 || /\b(?:ENOSPC|No space left on device)\b/i.test(output)) {
    return createDevboxError('disk_pressure', {
      retryable: true,
      context: { profileId, phase: 'sync' }
    })
  }
  return runnerFailed(profileId)
}

export async function runRsyncCommand(
  commandRunner: RsyncCommandRunner,
  profileId: string,
  args: readonly string[]
): Promise<void> {
  let result: RsyncCommandResult
  try {
    result = await commandRunner('rsync', args)
  } catch {
    throw runnerFailed(profileId)
  }
  if (result.exitCode !== 0) {
    throw classifyRsyncFailure(profileId, result)
  }
}
