import { getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import type { CommandHandler } from './handlers'

export const DEVBOX_PROFILE_PASTE_HANDLERS: Record<string, CommandHandler> = {
  'profile paste enable': async ({ flags, service, json }) => {
    const value = await service.enableProfilePaste(profile(flags), {
      localRoot: getOptionalStringFlag(flags, 'local-root'),
      remoteRoot: getOptionalStringFlag(flags, 'remote-root'),
      patterns: getRepeatedStringFlag(flags, 'pattern'),
      skipRemotePrepare: flags.get('skip-remote-prepare') === true
    })
    printResult('profile paste enable', 'profile.paste.enable', value, flags, json)
  },
  'profile paste disable': async ({ flags, service, json }) => {
    const value = await service.disableProfilePaste(profile(flags))
    printResult('profile paste disable', 'profile.paste.disable', value, flags, json)
  },
  'profile paste show': async ({ flags, service, json }) => {
    const value = service.showProfilePaste(profile(flags))
    printResult('profile paste show', 'profile.paste.show', value, flags, json)
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
