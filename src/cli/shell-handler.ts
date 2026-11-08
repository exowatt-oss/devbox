import { CliArgumentError } from './args'
import { formatDevboxStage, printDevboxResult } from './format'
import { operationKey } from './operations'
import { parseDevboxShellCommand } from './shell-command'
import { DevboxShellNotInTmuxError } from './shell-current'
import type { HandlerContext } from './handlers'
import { createShellLsLiveRenderer } from './shell-ls-live'
import { createPresentation } from './presentation'
import { unicodeEnabled } from './presentation-ansi'

export async function handleShell({ flags, service, positionalArgs, rawArgs, json, cwd, profileSelection }: HandlerContext): Promise<void> {
  if (rawArgs && rawArgs.length > 0) {
    throw new CliArgumentError('devbox shell does not accept passthrough arguments; use a shell verb or target.')
  }
  const command = parseDevboxShellCommand(positionalArgs ?? [], flags)
  const profileId = selectedProfile(flags)
  const explicit = isExplicitSelection(profileSelection, flags)

  if (command.verb === 'list') {
    if (!explicit && !json && process.stdout.isTTY === true && process.stderr.isTTY === true) {
      await listLive(service, flags.get('refresh') === true)
      return
    }
    const value = explicit ? await service.shellList(requiredProfile(flags)) : await service.shellListAll({ refresh: flags.get('refresh') === true })
    printShellResult('shell ls', 'shell.list', value, flags, json)
    return
  }
  if (command.verb === 'remove') {
    if (command.all) {
      const value = await service.shellKillAll(requiredProfile(flags))
      printShellResult('shell rm --all', 'shell.kill-all', value, flags, json)
      return
    }
    if (command.unattached) {
      if (command.allDevices) {
        const value = await service.shellKillUnattachedAll()
        printShellResult('shell rm --unattached --all-devices', 'shell.kill-unattached-all', value, flags, json)
        return
      }
      const value = await service.shellKillUnattached(requiredProfile(flags))
      const enriched = !json && !explicit ? await addDetachedHint(value, service, profileId) : value
      printShellResult('shell rm --unattached', 'shell.kill-unattached', enriched, flags, json)
      return
    }
    if (command.target === 'this') {
      let value
      try {
        value = await service.shellKillCurrent(profileId)
      } catch (error) {
        // Only a missing TMUX/TMUX_PANE means "not inside a shell"; every other
        // failure (foreign session, unresolvable pane, kill error) is surfaced as is.
        if (error instanceof DevboxShellNotInTmuxError) {
          throw new Error('devbox shell rm this must run inside a devbox shell (TMUX is not set)', { cause: error })
        }
        throw error
      }
      printShellResult('shell rm', 'shell.kill', value, flags, json)
      return
    }
    const located = !explicit && command.target !== undefined
      ? await service.shellLocate(command.target, profileId)
      : undefined
    writeLocationNote(located?.note, json)
    const targetProfile = located?.profileId ?? requiredProfile(flags)
    const value = await service.shellKill(targetProfile, command.target!)
    printShellResult('shell rm', 'shell.kill', value, flags, json)
    return
  }
  if (command.verb === 'resume') {
    const value = await service.shellResume(requiredProfile(flags), !json, !command.noReconnect, !command.noLoginRelay)
    process.exitCode = value.exitCode
    return
  }
  if (command.verb === 'reconnect-all') {
    // Without an explicit --profile/--device, cover every device `shell ls` lists.
    const value = await service.shellReconnectAll(explicit ? requiredProfile(flags) : undefined, {
      cwd,
      dryRun: command.dryRun,
      worktreeOverride: command.worktree,
      allowHere: !json && process.stdout.isTTY === true
    })
    printShellResult('shell reconnect --all', 'shell.reconnect-all', value, flags, json)
    if (!json && !command.dryRun) {
      const hereRow = value.rows.find((row) => row.action === 'here')
      if (hereRow !== undefined && hereRow.status !== 'failed') {
        // Attach by the unique tmux session name on the row's own profile; ids can repeat.
        const attached = await service.shellAttach(hereRow.profileId, hereRow.sessionName, true, true)
        process.exitCode = attached.exitCode
      }
    }
    return
  }
  const located = !explicit && command.verb === 'attach' && command.target !== undefined
    ? await service.shellLocate(command.target, profileId)
    : undefined
  writeLocationNote(located?.note, json)
  const targetProfile = located?.profileId ?? requiredProfile(flags)
  const value = command.verb === 'new'
    ? await service.shellNew(targetProfile, command.name, command.cwd, !json, !command.noReconnect, !command.noLoginRelay, command.run)
    : await service.shellAttach(targetProfile, command.target, !json, !command.noReconnect, !command.noLoginRelay)
  process.exitCode = value.exitCode
}

async function listLive(service: HandlerContext['service'], refresh: boolean): Promise<void> {
  const presentationOptions = { output: process.stdout, env: process.env }
  const live = createShellLsLiveRenderer({
    stdout: process.stdout,
    stderr: process.stderr,
    presentation: createPresentation(presentationOptions),
    glyphs: unicodeEnabled(presentationOptions)
  })
  try {
    live.finish(await service.shellListAll({ refresh, onProgress: (event) => live.onProgress(event) }))
  } finally {
    live.stop()
  }
}

function selectedProfile(flags: ReadonlyMap<string, string | boolean>): string | undefined {
  const value = flags.get('profile')
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requiredProfile(flags: ReadonlyMap<string, string | boolean>): string {
  const value = selectedProfile(flags)
  if (value !== undefined) {return value}
  throw new CliArgumentError('Missing required --profile')
}

function isExplicitSelection(
  selection: HandlerContext['profileSelection'],
  flags: ReadonlyMap<string, string | boolean>
): boolean {
  if (selection !== undefined) {
    return selection.source === 'explicit' || selection.source === 'environment'
  }
  return typeof flags.get('profile') === 'string' || typeof flags.get('device') === 'string'
}

async function addDetachedHint(
  value: unknown,
  service: HandlerContext['service'],
  selectedProfileId: string | undefined
): Promise<unknown> {
  try {
    const all = await service.shellListAll()
    const pending = all.devices.flatMap((device) => device.profiles
      .filter((profile) => profile.reachable && profile.profileId !== selectedProfileId)
      .map((profile) => ({ device: device.device, profile, detached: profile.sessions.filter((session) => !session.attached).length }))
      .filter((entry) => entry.detached > 0))
    if (pending.length === 0) {return value}
    const parts = pending.map((entry) => `${entry.device}/${entry.profile.profileId}: ${entry.detached} detached`)
    const only = pending.length === 1 ? pending[0]! : undefined
    const command = only === undefined
      ? 'db shell rm --unattached --all-devices'
      : `db shell rm --unattached ${only.profile.device === undefined ? `--profile ${only.profile.profileId}` : `--device ${only.profile.device}`}`
    return { ...(value as Record<string, unknown>), detachedHint: `${parts.join(' · ')} · ${command}` }
  } catch {
    return value
  }
}

function writeLocationNote(note: string | undefined, json: boolean): void {
  if (note === undefined || json) {return}
  try { process.stderr.write(`${note}\n`) } catch { /* best effort */ }
}

function printShellResult(
  command: string,
  operation: string,
  value: unknown,
  flags: Map<string, string | boolean>,
  json: boolean
): void {
  const key = flags.get('operation-key')
  const explicit = typeof key === 'string' && key.length > 0 ? key : undefined
  printDevboxResult(command, operation, value, operationKey(operation, value, explicit), json, formatDevboxStage)
}
