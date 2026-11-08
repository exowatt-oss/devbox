import { getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import type { CommandHandler } from './handlers'

export const DEVBOX_PROFILE_CREDENTIAL_HANDLERS: Record<string, CommandHandler> = {
  'profile credentials enable': async ({ flags, service, json }) => {
    const value = await service.enableProfileCredentials(profile(flags), {
      localRoot: getOptionalStringFlag(flags, 'local-root'),
      remoteRoot: getOptionalStringFlag(flags, 'remote-root'),
      excludes: getRepeatedStringFlag(flags, 'exclude')
    })
    printResult('profile credentials enable', 'profile.credentials.enable', value, flags, json)
  },
  'profile credentials disable': async ({ flags, service, json }) => {
    const value = await service.disableProfileCredentials(profile(flags))
    printResult('profile credentials disable', 'profile.credentials.disable', value, flags, json)
  },
  'profile credentials show': async ({ flags, service, json }) => {
    const value = service.showProfileCredentials(profile(flags))
    printResult('profile credentials show', 'profile.credentials.show', value, flags, json)
  }
}

function printResult(
  command: string,
  operation: string,
  value: unknown,
  flags: Map<string, string | boolean>,
  json: boolean
): void {
  printDevboxResult(
    command,
    operation,
    value,
    operationKey(operation, value, getOptionalStringFlag(flags, 'operation-key')),
    json,
    formatDevboxStage
  )
}

function profile(flags: Map<string, string | boolean>): string {
  return getRequiredStringFlag(flags, 'profile')
}
