import { CliArgumentError } from './args'
import { getOptionalNumberFlag, getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey, type ProfileCreateInput } from './operations'
import type { CommandHandler } from './handlers'
import { proxyCommandFlag } from './profile-proxy-command'

export const DEVBOX_PROFILE_CREATE_HANDLERS: Record<string, CommandHandler> = {
  'profile create': async ({ flags, service, json }) => {
    const input: ProfileCreateInput = {
      profileId: getRequiredStringFlag(flags, 'profile'),
      host: getRequiredStringFlag(flags, 'host'),
      port: getOptionalNumberFlag(flags, 'port') ?? 22,
      username: getRequiredStringFlag(flags, 'user'),
      localRoot: getRequiredStringFlag(flags, 'local-root'),
      remoteRoot: getRequiredStringFlag(flags, 'remote-root'),
      fingerprint: getOptionalStringFlag(flags, 'fingerprint'),
      ...proxyCommandFlag(flags),
      yes: flags.get('yes') === true,
      force: flags.get('force') === true,
      gitRoaming: flags.get('git-roaming') === true,
      dryRun: flags.get('dry-run') === true,
      ignore: getRepeatedStringFlag(flags, 'ignore')
    }
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new CliArgumentError('--port must be an integer between 1 and 65535.')
    }
    const value = await service.createProfile(input)
    printDevboxResult(
      'profile create',
      'profile.create',
      value,
      operationKey('profile.create', value, getOptionalStringFlag(flags, 'operation-key')),
      json,
      formatDevboxStage
    )
  }
}
