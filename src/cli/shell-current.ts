import { basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import { shellEscape } from '../ssh/shell-escape'
import type {
  DevboxShellKillResult
} from './shell-sessions'
import { parseDevboxLegacyShellSessionName, parseDevboxShellSessionName } from './shell-sessions'
import type { OwnedShell, DevboxShellSocketSelection } from './shell-lifecycle'
import { buildDevboxTmuxInvocation, devboxShellSocketName, type DevboxShellSocket } from './shell-tmux'

export type TmuxDisplayMessage = (
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => string

export type CurrentDevboxShellTarget = {
  sessionName: string
  socketSelection: DevboxShellSocketSelection
}

type ShellOutput = (line: string) => void
type DevboxExecFileSync = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; encoding: 'utf8'; stdio: ['ignore', 'ignore', 'pipe'] }) => unknown

type UnattachedShellOperations = {
  ensureTmux: (runner: DevboxSshRunner, output?: ShellOutput) => Promise<void>
  listOwned: (profileId: string, runner: DevboxSshRunner) => Promise<OwnedShell[]>
  assertSessionName: (profileId: string, sessionName: string) => void
}

/** Thrown when `rm this` runs without inherited TMUX/TMUX_PANE (i.e. outside tmux). */
export class DevboxShellNotInTmuxError extends Error {
  constructor() {
    super('Devbox shell rm this requires inherited TMUX and TMUX_PANE.')
    this.name = 'DevboxShellNotInTmuxError'
  }
}

/**
 * Resolve the session for the shell that invoked the CLI.
 *
 * This intentionally uses execFileSync rather than a shell command: TMUX and
 * TMUX_PANE are inherited process environment, not values that should be
 * interpolated into a local shell script.
 */
export function resolveCurrentDevboxShellTarget(
  env: NodeJS.ProcessEnv = process.env,
  displayMessage: TmuxDisplayMessage = runTmuxDisplayMessage
): CurrentDevboxShellTarget {
  const tmux = env.TMUX?.trim()
  const pane = env.TMUX_PANE?.trim()
  if (!tmux || !pane) {
    throw new DevboxShellNotInTmuxError()
  }

  let output: string
  try {
    output = displayMessage(['display-message', '-p', '-t', pane, '#{session_name}'], env)
  } catch {
    throw new Error('Devbox shell rm this could not resolve the current tmux session.')
  }

  const sessions = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (sessions.length !== 1) {
    throw new Error('Devbox shell rm this could not resolve exactly one current tmux session.')
  }
  return {
    sessionName: sessions[0]!,
    socketSelection: { socketName: inferTmuxSocketName(tmux) }
  }
}

export function resolveCurrentDevboxShellSession(
  env: NodeJS.ProcessEnv = process.env,
  displayMessage: TmuxDisplayMessage = runTmuxDisplayMessage
): string {
  return resolveCurrentDevboxShellTarget(env, displayMessage).sessionName
}

/** Build the race-safe exact-session kill used by rm --unattached. */
export function buildDevboxShellKillIfUnattachedCommand(
  sessionName: string,
  socketName?: DevboxShellSocket
): string {
  const target = shellEscape(sessionName)
  const tmux = buildDevboxTmuxInvocation(socketName, false)
  // Print evidence before killing the session: tmux cannot display a message
  // from a session after that kill removes the server's final session.
  const successBranch = [
    `display-message -p -t ${target} ${shellEscape('#{session_name}')}`,
    `kill-session -t ${target}`
  ].join('; ')
  return `${tmux} if-shell -F -t ${target} ${shellEscape('#{==:#{session_attached},0}')} ${shellEscape(successBranch)} 2>/dev/null || true`
}

export function killCurrentDevboxShellLocally(
  env: NodeJS.ProcessEnv = process.env,
  exec: DevboxExecFileSync = runTmuxKill,
  selectedProfileId?: string,
  displayMessage?: TmuxDisplayMessage
): DevboxShellKillResult {
  const current = resolveCurrentDevboxShellTarget(env, displayMessage)
  if (!current.sessionName.startsWith('devbox-')) {
    throw new Error(`Refusing tmux session outside the Devbox prefix: ${current.sessionName}`)
  }
  const selectedParsed = parseCurrentSessionIdentity(current.sessionName, selectedProfileId)
  const privateSocket = current.socketSelection.socketName?.startsWith('devbox-') === true
  const parsed = selectedParsed ?? (privateSocket ? parseCurrentSessionIdentity(current.sessionName, undefined, current.socketSelection.socketName) : undefined)
  if (!privateSocket && selectedParsed === undefined) {
    throw new Error(`Current tmux session '${current.sessionName}' is not owned by Devbox.`)
  }
  exec('tmux', ['kill-session', '-t', current.sessionName], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const identity = parsed?.identity
  return {
    profileId: parsed?.profileId ?? selectedProfileId ?? 'unknown',
    ...(identity?.id === undefined ? {} : { id: identity.id }),
    ...(identity?.name === undefined ? {} : { name: identity.name }),
    sessionName: current.sessionName,
    killed: true
  }
}

/** Compatibility wrapper retained for callers compiled against the old remote-kill signature. */
export async function killCurrentDevboxShell(
  profileId: string,
  _env: NodeJS.ProcessEnv,
  _kill: (sessionName: string, socketSelection: DevboxShellSocketSelection) => Promise<DevboxShellKillResult>,
  displayMessage?: TmuxDisplayMessage
): Promise<DevboxShellKillResult> {
  return killCurrentDevboxShellLocally(_env, runTmuxKill, profileId, displayMessage)
}

export async function killUnattachedDevboxShells(
  profileId: string,
  runner: DevboxSshRunner,
  output: ShellOutput | undefined,
  operations: UnattachedShellOperations
): Promise<{ profileId: string; count: number; sessions: readonly string[]; killed: true }> {
  await operations.ensureTmux(runner, output)
  const sessions = await operations.listOwned(profileId, runner)
  const killedSessions: string[] = []
  for (const owned of sessions) {
    const attached = owned.canonical ? owned.session.attached : owned.attached
    // Lifecycle parsing treats every value other than the exact tmux value 0
    // as attached. This fails closed for unknown or malformed metadata.
    if (attached) {continue}
    const sessionName = owned.session.sessionName
    operations.assertSessionName(profileId, sessionName)
    const evidence = await runner.command(
      buildDevboxShellKillIfUnattachedCommand(sessionName, owned.socketName)
    )
    if (evidence.split(/\r?\n/u).some((line) => line.trim() === sessionName)) {
      killedSessions.push(sessionName)
    }
  }
  return {
    profileId,
    count: killedSessions.length,
    sessions: killedSessions,
    killed: true
  }
}

function inferTmuxSocketName(tmux: string): DevboxShellSocket {
  const socket = basename(tmux.split(',', 1)[0]!.trim())
  return socket.startsWith('devbox-') && socket.length > 'devbox-'.length
    ? socket
    : undefined
}

type CurrentSessionIdentity = {
  profileId: string
  identity: { id?: number; name?: string }
}

function parseCurrentSessionIdentity(
  sessionName: string,
  selectedProfileId?: string,
  socketName?: DevboxShellSocket
): CurrentSessionIdentity | undefined {
  if (selectedProfileId !== undefined) {
    const canonical = parseDevboxShellSessionName(selectedProfileId, sessionName)
    const legacy = parseDevboxLegacyShellSessionName(selectedProfileId, sessionName)
    if (canonical !== undefined) {return { profileId: selectedProfileId, identity: canonical }}
    if (legacy !== undefined) {return { profileId: selectedProfileId, identity: { name: legacy.name } }}
    return undefined
  }
  // Profile ids may themselves contain '-', so every split of the name is a
  // candidate. The private socket name is sha256(profileId)-derived and picks
  // the exact owner; without a socket match the shortest profile prefix wins.
  const parts = sessionName.slice('devbox-'.length).split('-')
  let fallback: CurrentSessionIdentity | undefined
  for (let count = 1; count < parts.length; count += 1) {
    const profileId = parts.slice(0, count).join('-')
    const match = /^([1-9][0-9]*)(?:-([A-Za-z0-9._-]+))?$/u.exec(parts.slice(count).join('-'))
    if (match === null || !Number.isSafeInteger(Number(match[1]))) {continue}
    const candidate = { profileId, identity: { id: Number(match[1]), ...(match[2] === undefined ? {} : { name: match[2] }) } }
    if (socketName !== undefined && devboxShellSocketName(profileId) === socketName) {return candidate}
    fallback ??= candidate
  }
  return fallback
}

function runTmuxKill(file: string, args: string[], options: { env: NodeJS.ProcessEnv; encoding: 'utf8'; stdio: ['ignore', 'ignore', 'pipe'] }): unknown {
  return execFileSync(file, args, options)
}

function runTmuxDisplayMessage(args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('tmux', [...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}
