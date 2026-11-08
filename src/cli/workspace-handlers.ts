import { homedir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { CliArgumentError } from './args'
import { getOptionalNumberFlag, getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import { resolveDevboxEnvFilePath } from './profile-preferences'
import { createPresentation } from './presentation'
import type { CommandHandler } from './handlers'
import type { BootstrapProgress, BootstrapStep, ConnectWorkspaceInput, DevboxHubServiceLike, InitWorkspaceInput, WorkspaceBootstrapResult } from './hub-types'
import { proxyCommandFlag } from './profile-proxy-command'

export const DEVBOX_WORKSPACE_HANDLERS: Record<string, CommandHandler> = {
  init: (ctx) => runInit(ctx),
  connect: (ctx) => runConnect(ctx)
}

export function resolveLocalPath(value: string, cwd: string): string {
  const expanded = value === '~' || value.startsWith('~/')
    ? join(homedir(), value === '~' ? '' : value.slice(2))
    : value
  return resolve(cwd, expanded)
}

async function runInit(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  const service = requireWorkspaceMethod(ctx.service, 'initWorkspace', 'init')
  let input: InitWorkspaceInput
  try {
    input = {
      host: getRequiredStringFlag(ctx.flags, 'host'),
      port: port(ctx.flags),
      user: getRequiredStringFlag(ctx.flags, 'user'),
      profileId: getOptionalStringFlag(ctx.flags, 'profile'),
      localRoot: resolveLocalPath(getRequiredStringFlag(ctx.flags, 'local-root'), ctx.cwd),
      remoteRoot: absolutePath(ctx.flags, 'remote-root'),
      fingerprint: getOptionalStringFlag(ctx.flags, 'fingerprint'),
      ...proxyCommandFlag(ctx.flags),
      yes: ctx.flags.get('yes') === true,
      force: ctx.flags.get('force') === true,
      envFile: envFile(ctx),
      shellDir: absolutePath(ctx.flags, 'shell-dir'),
      service: ctx.flags.get('no-service') !== true,
      pair: ctx.flags.get('no-pair') !== true,
      adoptRemote: ctx.flags.get('adopt-remote') === true
    }
  } catch (error) {
    throw withUsage(error, 'devbox init')
  }
  const value = await service(input, progressFor(ctx))
  printWorkspaceResult('init', value, ctx)
}

async function runConnect(ctx: Parameters<CommandHandler>[0]): Promise<void> {
  const service = requireWorkspaceMethod(ctx.service, 'connectWorkspace', 'connect')
  let input: ConnectWorkspaceInput
  try {
    input = {
      host: getRequiredStringFlag(ctx.flags, 'host'),
      port: port(ctx.flags),
      user: getRequiredStringFlag(ctx.flags, 'user'),
      profileId: getOptionalStringFlag(ctx.flags, 'profile'),
      localRoot: optionalLocalRoot(ctx),
      remoteRoot: requiredAbsolutePath(ctx.flags, 'remote-root'),
      fingerprint: getOptionalStringFlag(ctx.flags, 'fingerprint'),
      ...proxyCommandFlag(ctx.flags),
      yes: ctx.flags.get('yes') === true,
      force: ctx.flags.get('force') === true,
      envFile: envFile(ctx),
      shellDir: absolutePath(ctx.flags, 'shell-dir'),
      service: ctx.flags.get('no-service') !== true,
      pair: ctx.flags.get('no-pair') !== true,
      allowNonEmptyLocal: ctx.flags.get('allow-non-empty-local') === true
    }
  } catch (error) {
    throw withUsage(error, 'devbox connect')
  }
  const value = await service(input, progressFor(ctx))
  printWorkspaceResult('connect', value, ctx)
}

function port(flags: Map<string, string | boolean>): number {
  const value = getOptionalNumberFlag(flags, 'port') ?? 22
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new CliArgumentError('--port must be an integer between 1 and 65535.')
  }
  return value
}

function optionalLocalRoot(ctx: Parameters<CommandHandler>[0]): string | undefined {
  const value = getOptionalStringFlag(ctx.flags, 'local-root')
  return value === undefined ? undefined : resolveLocalPath(value, ctx.cwd)
}

function requiredAbsolutePath(flags: Map<string, string | boolean>, name: string): string {
  const value = getRequiredStringFlag(flags, name)
  return assertAbsolutePath(value, `--${name} must be an absolute POSIX path.`)
}

function absolutePath(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = getOptionalStringFlag(flags, name)
  return value === undefined ? undefined : assertAbsolutePath(value, `--${name} must be an absolute POSIX path.`)
}

function assertAbsolutePath(value: string, message: string): string {
  if (!posix.isAbsolute(value)) {
    throw new CliArgumentError(message)
  }
  return value
}

function envFile(ctx: Parameters<CommandHandler>[0]): string | undefined {
  const value = getOptionalStringFlag(ctx.flags, 'env-file')
  if (value === undefined) {
    return undefined
  }
  try {
    return resolveDevboxEnvFilePath(value, ctx.cwd)
  } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error))
  }
}

function progressFor(ctx: Parameters<CommandHandler>[0]): BootstrapProgress | undefined {
  if (ctx.json) {
    return undefined
  }
  const presentation = createPresentation(ctx.presentation ?? { output: process.stderr, env: process.env })
  return (step: BootstrapStep): void => {
    const kind = step.status === 'ok'
      ? 'success'
      : step.status === 'skipped'
        ? 'muted'
        : step.status === 'warning'
          ? 'warning'
          : 'error'
    process.stderr.write(`${presentation.status(kind, `${step.id.padEnd(15)} ${step.detail}`)}\n`)
  }
}

function printWorkspaceResult(
  command: string,
  value: WorkspaceBootstrapResult,
  ctx: Parameters<CommandHandler>[0]
): void {
  printDevboxResult(
    command,
    command,
    value,
    operationKey(command, value, getOptionalStringFlag(ctx.flags, 'operation-key')),
    ctx.json,
    formatDevboxStage,
    ctx.presentation
  )
  if (value.status !== 'ready') {
    process.exitCode = 1
  }
}

function withUsage(error: unknown, command: 'devbox init' | 'devbox connect'): CliArgumentError {
  const message = error instanceof Error ? error.message : String(error)
  const usage = command === 'devbox init'
    ? 'devbox init --host <h> --user <u> --local-root <abs> [--remote-root <abs>] [--yes]'
    : 'devbox connect --host <h> --user <u> --remote-root <abs> [--local-root <abs>] [--yes]'
  return new CliArgumentError(`${message}\nUsage: ${usage}`)
}

function requireWorkspaceMethod<Name extends 'initWorkspace' | 'connectWorkspace'>(
  service: DevboxHubServiceLike,
  name: Name,
  command: string
): NonNullable<DevboxHubServiceLike[Name]> {
  const method = service[name]
  if (typeof method !== 'function') {
    throw new CliArgumentError(`devbox ${command} is unavailable in this service.`)
  }
  return method.bind(service) as NonNullable<DevboxHubServiceLike[Name]>
}
