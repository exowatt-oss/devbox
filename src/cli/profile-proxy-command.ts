import { createDevboxError } from '../shared/devbox-errors'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { normalizeDevboxProxyCommand } from '../ssh/ssh-proxy'
import { CliArgumentError, type FlagValue } from './args'
import { getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import type { CommandHandler } from './handlers'

export type DevboxProfileProxyCommandResult = {
  profileId: string
  proxyCommand: string | null
}

/** `--proxy-command <cmd>` for init/connect/profile create; validated, absent when not given. */
export function proxyCommandFlag(flags: Map<string, FlagValue>): { proxyCommand?: string } {
  if (!flags.has('proxy-command')) {return {}}
  const value = getOptionalStringFlag(flags, 'proxy-command')
  if (value === undefined) {throw new CliArgumentError('--proxy-command requires a command, e.g. --proxy-command "$HOME/.local/bin/devbox proxy"')}
  try { return { proxyCommand: normalizeDevboxProxyCommand(value) } } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error))
  }
}

export function setDevboxProfileProxyCommand(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string,
  proxyCommand: string | undefined
): DevboxProfileProxyCommandResult {
  const store = new DevboxProfileStore({ rootDir: profileRoot, env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  const { proxyCommand: _previous, ...sshTarget } = loaded.profile.sshTarget
  const next = proxyCommand === undefined ? sshTarget : { ...sshTarget, proxyCommand: normalizeDevboxProxyCommand(proxyCommand) }
  const saved = store.saveProfile({ ...loaded.profile, sshTarget: next })
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed', { context: { profileId } })
  }
  return { profileId: saved.profile.id, proxyCommand: saved.profile.sshTarget.proxyCommand ?? null }
}

export function showDevboxProfileProxyCommand(
  profileRoot: string,
  env: NodeJS.ProcessEnv,
  profileId: string
): DevboxProfileProxyCommandResult {
  const loaded = new DevboxProfileStore({ rootDir: profileRoot, env }).loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found', { context: { profileId } })
  }
  return { profileId: loaded.profile.id, proxyCommand: loaded.profile.sshTarget.proxyCommand ?? null }
}

export const DEVBOX_PROFILE_PROXY_COMMAND_HANDLERS: Record<string, CommandHandler> = {
  'profile proxy-command set': async ({ flags, service, positionalArgs, json }) => {
    const requested = positionalArgs ?? []
    if (requested.length !== 1) {
      throw new CliArgumentError('Usage: devbox profile proxy-command set "<command>" --profile <id> (quote the command as one argument)')
    }
    let command: string
    try { command = normalizeDevboxProxyCommand(requested[0]!) } catch (error) {
      throw new CliArgumentError(error instanceof Error ? error.message : String(error))
    }
    printResult('profile proxy-command set', await service.setProfileProxyCommand(profile(flags), command), flags, json)
  },
  'profile proxy-command clear': async ({ flags, service, positionalArgs, json }) => {
    if ((positionalArgs ?? []).length > 0) {throw new CliArgumentError('Usage: devbox profile proxy-command clear --profile <id>')}
    printResult('profile proxy-command clear', await service.setProfileProxyCommand(profile(flags), undefined), flags, json)
  },
  'profile proxy-command show': async ({ flags, service, positionalArgs, json }) => {
    if ((positionalArgs ?? []).length > 0) {throw new CliArgumentError('Usage: devbox profile proxy-command show --profile <id>')}
    printResult('profile proxy-command show', service.showProfileProxyCommand(profile(flags)), flags, json)
  }
}

function printResult(command: string, value: unknown, flags: Map<string, FlagValue>, json: boolean): void {
  const operation = command.replaceAll(' ', '.')
  printDevboxResult(command, operation, value, operationKey(operation, value, getOptionalStringFlag(flags, 'operation-key')), json, formatDevboxStage)
}

function profile(flags: Map<string, FlagValue>): string {
  return getRequiredStringFlag(flags, 'profile')
}
