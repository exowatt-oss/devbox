import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import { buildShellAttachMarkerInput } from './shell-terminal-attach'
import {
  resolveDevboxResumeTarget,
  type DevboxShellAttachHistory
} from './shell-attach-history'
import { buildDevboxShellCredentialPrepareScript } from './shell-scripts'
import { ensureDevboxShellDirectory, resolveDevboxShellCwd } from './shell-paths'
import {
  killCurrentDevboxShellLocally,
  killUnattachedDevboxShells as killUnattachedDevboxShellsWithOperations
} from './shell-current'

export {
  buildDevboxShellAttachCommand,
  buildDevboxShellCredentialPrepareScript
} from './shell-scripts'
export type { DevboxShellLoginRelayFactory, DevboxShellLoginRelaySession } from './shell-login-relay-attach'
import type { TmuxDisplayMessage } from './shell-current'
import { stageDevboxCredentialEnv } from '../core/devbox-credential-env'
import { runDevboxShellWithLoginRelay, type DevboxShellLoginRelayFactory } from './shell-login-relay-attach'

import { assertDevboxOwnedShellSessionName } from './shell-sessions'
import {
  buildDevboxShellKillCommand,
  devboxShellSocketName,
  ensureDevboxTmux
} from './shell-tmux'
import {
  buildDevboxShellListResult,
  canonicalSessions,
  createNextShellIdentity,
  listOwnedDevboxShellSessions,
  resolveDevboxShellTarget,
  selectMostRecentCanonicalSession
} from './shell-lifecycle'
import type { DevboxShellSocketSelection } from './shell-lifecycle'
import type { DevboxShellAttachResult, DevboxShellKillAllResult, DevboxShellKillResult, DevboxShellKillUnattachedResult, DevboxShellListResult } from './shell-sessions'
export {
  assertDevboxOwnedShellSessionName,
  assertDevboxShellSessionName,
  allocateDevboxShellId,
  buildDevboxLegacyShellSessionName,
  buildDevboxShellSessionName,
  devboxShellSessionPrefix,
  parseDevboxLegacyShellSessionName,
  parseDevboxShellSessionLine,
  parseDevboxShellSessionName,
  selectMostRecentDevboxShellSession,
  sanitizeDevboxShellComponent
} from './shell-sessions'
export type {
  DevboxLegacyShellSessionIdentity,
  DevboxShellAttachResult,
  DevboxShellKillAllResult,
  DevboxShellKillResult,
  DevboxShellKillUnattachedResult,
  DevboxShellListResult,
  DevboxShellSession,
  DevboxShellSessionIdentity
} from './shell-sessions'
export {
  buildDevboxShellKillCommand,
  buildDevboxShellListCommand,
  DEVBOX_DARWIN_SHELL_INSTALL_COMMAND,
  DEVBOX_SHELL_INSTALL_COMMAND,
  devboxShellSocketName,
  ensureDevboxTmux
} from './shell-tmux'
export { buildDevboxShellKillIfUnattachedCommand } from './shell-current'
export { ensureDevboxShellDirectory, resolveDevboxShellCwd, validateDevboxShellPath } from './shell-paths'

export type ShellOutput = (line: string) => void
export type DevboxShellAttachOptions = {
  reconnect?: boolean
  history?: DevboxShellAttachHistory
  loginRelay?: DevboxShellLoginRelayFactory
  deviceLabel?: string
  /** `shell new --run <command>`: typed into the fresh shell once. Only newDevboxShell honours it. */
  initialInput?: string
  local?: boolean
  interactive?: (remoteCommand: string, options?: { remoteForwards?: readonly string[] }) => Promise<number>
}

export function resolveDevboxShellAttachSocket(
  profileId: string,
  existing: DevboxShellSocketSelection | undefined
): string | undefined {
  return existing === undefined ? devboxShellSocketName(profileId) : existing.socketName
}

export async function attachDevboxShell(
  profileId: string,
  target: string | undefined,
  remoteRoot: string,
  profileShellDir: string | undefined,
  runner: DevboxSshRunner,
  endpoint: SshEndpoint,
  output?: ShellOutput,
  envFile?: string,
  terminalMarkers = true,
  options: DevboxShellAttachOptions = {}
): Promise<DevboxShellAttachResult> {
  await ensureDevboxTmux(runner, output)
  const sessions = await listOwnedDevboxShellSessions(profileId, runner)
  const existing = target === undefined
    ? selectMostRecentCanonicalSession(sessions)
    : resolveDevboxShellTarget(target, sessions)
  const identity = existing?.session ?? createNextShellIdentity(profileId, canonicalSessions(sessions))
  try {
    await options.history?.record({ profileId, sessionName: identity.sessionName, id: identity.id, ...(identity.name === undefined ? {} : { name: identity.name }) })
  } catch {
    // Attach history is best effort and must never block the shell.
  }
  // New sessions always use the private socket. An existing canonical session
  // keeps the socket on which lifecycle discovery found it, including legacy
  // default-socket sessions during the transition.
  const socketName = resolveDevboxShellAttachSocket(profileId, existing)
  const remoteCwd = resolveDevboxShellCwd(remoteRoot, profileShellDir)
  if (existing === undefined) {
    await ensureDevboxShellDirectory(runner, remoteCwd)
  }
  if (envFile !== undefined) {
    await stageDevboxCredentialEnv(runner, profileId, envFile)
    await runner.script(
      buildDevboxShellCredentialPrepareScript(profileId, identity.sessionName, remoteCwd, socketName),
      15_000
    )
  }
  const markerInput = buildShellAttachMarkerInput(profileId, identity, endpoint, socketName, existing?.session.currentCommand === 'phi', existing === undefined ? remoteCwd : undefined)
  const outcome = await runDevboxShellWithLoginRelay({ profileId, identity, remoteCwd, socketName, endpoint, runner, markerInput, terminalMarkers, reconnect: options.reconnect !== false, loginRelay: options.loginRelay, deviceLabel: options.deviceLabel, local: options.local, interactive: options.interactive })
  return {
    ...identity,
    profileId,
    exitCode: outcome.exitCode,
    ...(outcome.attempts > 1 ? { reconnectAttempts: outcome.attempts - 1 } : {})
  }
}

export async function newDevboxShell(
  profileId: string,
  name: string | undefined,
  remoteRoot: string,
  profileShellDir: string | undefined,
  cwdOverride: string | undefined,
  runner: DevboxSshRunner,
  endpoint: SshEndpoint,
  output?: ShellOutput,
  envFile?: string,
  terminalMarkers = true,
  options: DevboxShellAttachOptions = {}
): Promise<DevboxShellAttachResult> {
  await ensureDevboxTmux(runner, output)
  const sessions = await listOwnedDevboxShellSessions(profileId, runner)
  const identity = createNextShellIdentity(profileId, canonicalSessions(sessions), name)
  try {
    await options.history?.record({ profileId, sessionName: identity.sessionName, id: identity.id, ...(identity.name === undefined ? {} : { name: identity.name }) })
  } catch {
    // Attach history is best effort and must never block the shell.
  }
  const socketName = devboxShellSocketName(profileId)
  const remoteCwd = resolveDevboxShellCwd(remoteRoot, profileShellDir, cwdOverride)
  await ensureDevboxShellDirectory(runner, remoteCwd)
  if (envFile !== undefined) {
    await stageDevboxCredentialEnv(runner, profileId, envFile)
    await runner.script(
      buildDevboxShellCredentialPrepareScript(profileId, identity.sessionName, remoteCwd, socketName),
      15_000
    )
  }
  const markerInput = buildShellAttachMarkerInput(profileId, identity, endpoint, socketName, false, remoteCwd)
  const outcome = await runDevboxShellWithLoginRelay({ profileId, identity, remoteCwd, socketName, endpoint, runner, markerInput, terminalMarkers, reconnect: options.reconnect !== false, loginRelay: options.loginRelay, deviceLabel: options.deviceLabel, local: options.local, interactive: options.interactive, initialInput: options.initialInput })
  return {
    ...identity,
    profileId,
    exitCode: outcome.exitCode,
    ...(outcome.attempts > 1 ? { reconnectAttempts: outcome.attempts - 1 } : {})
  }
}

export async function resumeDevboxShell(
  profileId: string,
  remoteRoot: string,
  profileShellDir: string | undefined,
  runner: DevboxSshRunner,
  endpoint: SshEndpoint,
  history: DevboxShellAttachHistory,
  output?: ShellOutput,
  envFile?: string,
  terminalMarkers = true,
  options: DevboxShellAttachOptions = {}
): Promise<DevboxShellAttachResult> {
  await ensureDevboxTmux(runner, output)
  const sessions = await listOwnedDevboxShellSessions(profileId, runner)
  const target = await resolveDevboxResumeTarget(history, profileId, canonicalSessions(sessions))
  if (target === undefined) {
    return attachDevboxShell(profileId, undefined, remoteRoot, profileShellDir, runner, endpoint, output, envFile, terminalMarkers, options)
  }
  if (target.source !== 'terminal') {
    const name = target.session.name === undefined ? '' : ` (${target.session.name})`
    const suffix = target.source === 'profile' ? ' — last used from this machine' : ' — no record for this terminal'
    try {
      process.stderr.write(`devbox: resuming most recent shell #${target.session.id}${name}${suffix}\n`)
    } catch {
      // Resume notices are best effort.
    }
  }
  return attachDevboxShell(profileId, target.session.sessionName, remoteRoot, profileShellDir, runner, endpoint, output, envFile, terminalMarkers, options)
}

export async function listDevboxShellSessions(
  profileId: string,
  runner: DevboxSshRunner,
  output?: ShellOutput,
  timeoutMs?: number
): Promise<DevboxShellListResult> {
  await ensureDevboxTmux(runner, output, timeoutMs)
  return buildDevboxShellListResult(profileId, await listOwnedDevboxShellSessions(profileId, runner, timeoutMs))
}

export function killCurrentDevboxShell(
  profileId: string | undefined,
  _runner?: DevboxSshRunner,
  env: NodeJS.ProcessEnv = process.env,
  _output?: ShellOutput,
  displayMessage?: TmuxDisplayMessage
): Promise<DevboxShellKillResult> {
  return Promise.resolve(killCurrentDevboxShellLocally(env, undefined, profileId, displayMessage))
}

export async function killDevboxShell(
  profileId: string,
  target: string,
  runner: DevboxSshRunner,
  output?: ShellOutput,
  socketSelection?: DevboxShellSocketSelection
): Promise<DevboxShellKillResult> {
  await ensureDevboxTmux(runner, output)
  const sessions = await listOwnedDevboxShellSessions(profileId, runner)
  const identity = resolveDevboxShellTarget(target, sessions, true, socketSelection)
  assertDevboxOwnedShellSessionName(profileId, identity.session.sessionName)
  await runner.command(buildDevboxShellKillCommand(identity.session.sessionName, identity.socketName, true))
  return {
    ...identity.session,
    profileId,
    killed: true
  }
}

export function killUnattachedDevboxShells(
  profileId: string,
  runner: DevboxSshRunner,
  output?: ShellOutput
): Promise<DevboxShellKillUnattachedResult> {
  return killUnattachedDevboxShellsWithOperations(profileId, runner, output, {
    ensureTmux: ensureDevboxTmux,
    listOwned: listOwnedDevboxShellSessions,
    assertSessionName: assertDevboxOwnedShellSessionName
  })
}

export async function killAllDevboxShells(
  profileId: string,
  runner: DevboxSshRunner,
  output?: ShellOutput
): Promise<DevboxShellKillAllResult> {
  await ensureDevboxTmux(runner, output)
  const sessions = await listOwnedDevboxShellSessions(profileId, runner)
  for (const session of sessions) {
    assertDevboxOwnedShellSessionName(profileId, session.session.sessionName)
    // The session may disappear between list and kill. A missing target is a
    // successful cleanup outcome; never broaden this to kill-server or a glob.
    await runner.command(buildDevboxShellKillCommand(session.session.sessionName, session.socketName, true))
  }
  return {
    profileId,
    count: sessions.length,
    sessions: sessions.map((session) => session.session.sessionName),
    killed: true
  }
}
