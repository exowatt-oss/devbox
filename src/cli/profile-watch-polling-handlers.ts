import { CliArgumentError } from './args'
import { getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import type { CommandHandler } from './handlers'

export const DEVBOX_PROFILE_WATCH_POLLING_HANDLERS: Record<string, CommandHandler> = {
  'profile sync-watch-polling-interval': async ({ flags, service, positionalArgs, json }) => {
    if (flags.get('clear') !== true || (positionalArgs ?? []).length > 0) {
      throw new CliArgumentError('Usage: devbox profile sync-watch-polling-interval --clear')
    }
    const value = await service.setProfileWatchPollingInterval(profile(flags), undefined)
    printResult('profile sync-watch-polling-interval', 'profile.sync-watch-polling-interval.clear', value, flags, json)
  },
  'profile sync-watch-polling-interval set': async ({ flags, service, positionalArgs, json }) => {
    const requested = positionalArgs ?? []
    if (requested.length !== 1) {
      throw new CliArgumentError('Usage: devbox profile sync-watch-polling-interval set <seconds>')
    }
    const watchPollingIntervalSeconds = Number(requested[0])
    if (!Number.isSafeInteger(watchPollingIntervalSeconds) || watchPollingIntervalSeconds < 1) {
      throw new CliArgumentError('<seconds> must be a positive safe integer.')
    }
    const value = await service.setProfileWatchPollingInterval(profile(flags), watchPollingIntervalSeconds)
    printResult('profile sync-watch-polling-interval set', 'profile.sync-watch-polling-interval.set', value, flags, json)
  },
  'profile sync-watch-polling-interval show': async ({ flags, service, positionalArgs, json }) => {
    if ((positionalArgs ?? []).length > 0) {
      throw new CliArgumentError('Usage: devbox profile sync-watch-polling-interval show')
    }
    const value = service.showProfileWatchPollingInterval(profile(flags))
    printResult('profile sync-watch-polling-interval show', 'profile.sync-watch-polling-interval.show', value, flags, json)
  }
}

function printResult(
  command: string,
  operation: string,
  value: unknown,
  flags: Map<string, string | boolean>,
  json: boolean
): void {
  printDevboxResult(command, operation, value, operationKey(operation, value, getOptionalStringFlag(flags, 'operation-key')), json, formatDevboxStage)
}

function profile(flags: Map<string, string | boolean>): string {
  return getRequiredStringFlag(flags, 'profile')
}
