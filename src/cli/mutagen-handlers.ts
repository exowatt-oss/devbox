import { CliArgumentError } from './args'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey, type DevboxServiceLike } from './operations'
import type { CommandHandler } from './handlers'
import type { MutagenServiceAction, MutagenSessionAction } from './hub-types'
import { handleSyncNow } from './sync-now-handler'

export const DEVBOX_MUTAGEN_HANDLERS: Record<string, CommandHandler> = {
  'mutagen status': async (ctx) => {
    const service = requireMethod(ctx.service, 'mutagenStatus', 'mutagen status')
    const profileId = getOptionalStringFlag(ctx.flags, 'profile')
    const value = await service(profileId, { remote: ctx.flags.get('no-remote') !== true })
    printResult('mutagen status', 'mutagen.status', value, ctx)
    const result = value as { topology?: { verdict?: string }; service?: { installed?: boolean }; daemon?: { running?: boolean; origin?: string } }
    const unhealthy = result.topology?.verdict === 'violation' || (result.service?.installed === true && result.daemon?.running === false && result.daemon?.origin !== 'unknown')
    process.exitCode = unhealthy ? 1 : 0
  },
  'mutagen setup': async (ctx) => {
    const service = requireMethod(ctx.service, 'mutagenSetup', 'mutagen setup')
    const profileId = getOptionalStringFlag(ctx.flags, 'profile')
    const value = await service(profileId, {
      service: ctx.flags.get('no-service') !== true,
      remote: ctx.flags.get('no-remote') !== true
    })
    printResult('mutagen setup', 'mutagen.setup', value, ctx)
  },
  'mutagen start': (ctx) => runServiceAction('mutagen start', 'start', ctx),
  'mutagen stop': (ctx) => runServiceAction('mutagen stop', 'stop', ctx),
  'mutagen restart': (ctx) => runServiceAction('mutagen restart', 'restart', ctx),
  'mutagen delete': (ctx) => runServiceAction('mutagen delete', 'delete', ctx),
  'mutagen uninstall': (ctx) => runServiceAction('mutagen delete', 'delete', ctx),
  'mutagen logs': async (ctx) => {
    const service = requireMethod(ctx.service, 'mutagenLogs', 'mutagen logs')
    const lines = getOptionalPositiveIntegerFlag(ctx.flags, 'lines') ?? 80
    const value = await service(lines)
    printResult('mutagen logs', 'mutagen.logs', value, ctx)
  },
  'mutagen flush': (ctx) => runOneShotSync(ctx),
  'mutagen pause': (ctx) => runSessionAction('pause', ctx),
  'mutagen resume': (ctx) => runOneShotSync(ctx),
  'mutagen spokes': async (ctx) => {
    const service = requireMethod(ctx.service, 'mutagenSpokes', 'mutagen spokes')
    const profileId = getRequiredStringFlag(ctx.flags, 'profile')
    const value = await service(profileId)
    printResult('mutagen spokes', 'mutagen.spokes', value, ctx)
  }
}

function runServiceAction(
  command: string,
  action: MutagenServiceAction,
  ctx: Parameters<CommandHandler>[0]
): Promise<void> {
  const service = requireMethod(ctx.service, 'mutagenServiceAction', command)
  return service(action).then((value) => {
    printResult(command, `mutagen.${action}`, value, ctx)
    if (action === 'stop') {
      process.exitCode = 0
    }
  })
}

/**
 * `mutagen flush|resume` = `db sync --profile <id>`: one resume → flush → pause cycle.
 * Devbox never leaves a session live-syncing, so there is no "resume and keep watching".
 */
function runOneShotSync(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  const flags = new Map(ctx.flags)
  flags.delete('device')
  flags.set('profile', getRequiredStringFlag(ctx.flags, 'profile'))
  return handleSyncNow({ ...ctx, flags, positionalArgs: [], rawArgs: [] })
}

async function runSessionAction(
  action: MutagenSessionAction,
  ctx: Parameters<CommandHandler>[0]
): Promise<void> {
  const service = requireMethod(ctx.service, 'mutagenSessionAction', `mutagen ${action}`)
  const profileId = getRequiredStringFlag(ctx.flags, 'profile')
  const value = await service(profileId, action)
  printResult(`mutagen ${action}`, `mutagen.${action}`, value, ctx)
}

function requireMethod<Name extends keyof DevboxServiceLike>(
  service: DevboxServiceLike,
  name: Name,
  command: string
): NonNullable<DevboxServiceLike[Name]> {
  const method = service[name]
  if (typeof method !== 'function') {
    throw new CliArgumentError(`devbox ${command} is unavailable in this service.`)
  }
  return method.bind(service) as NonNullable<DevboxServiceLike[Name]>
}

function printResult(
  command: string,
  operation: string,
  value: unknown,
  ctx: Parameters<CommandHandler>[0]
): void {
  printDevboxResult(
    command,
    operation,
    value,
    operationKey(operation, value, getOptionalStringFlag(ctx.flags, 'operation-key')),
    ctx.json,
    formatDevboxStage,
    ctx.presentation
  )
}
