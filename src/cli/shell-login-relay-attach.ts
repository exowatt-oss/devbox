import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import {
  runDevboxShellInteractive,
  writeShellAbandonedMarker,
  writeShellReconnectingMarker
} from './shell-terminal-attach'
import { buildDevboxShellAttachCommand } from './shell-scripts'
import {
  formatDevboxShellReconnectLabel,
  isDevboxShellReconnectEnabled,
  runDevboxShellWithReconnect,
  SSH_TRANSPORT_FAILURE_EXIT_CODE,
  type DevboxShellReconnectOutcome
} from './shell-reconnect'
import type { TerminalMarkerAttachInput } from './shell-terminal-marker'
import {
  buildDevboxLoginRelayPrepareScript,
  buildDevboxLoginRelayWatcherScript,
  isDevboxLoginRelayEnabled,
  parseDevboxLoginRelayPrepareOutput,
  resolveDevboxLoginRelayPorts
} from './shell-login-relay-remote'
import { startDevboxLoginRelay, type DevboxLoginRelayHandle } from './shell-login-relay'

type RelayAttempt = { remoteForwards: string[]; relay: { watcherScript: string } }
export type DevboxShellLoginRelaySession = {
  prepareAttempt(): Promise<RelayAttempt | undefined>
  stop(): Promise<void>
}
export type DevboxShellLoginRelayFactory = (input: {
  runner: DevboxSshRunner
  deviceLabel: string
}) => Promise<DevboxShellLoginRelaySession | undefined>

export type DevboxShellRelayAttachInput = {
  profileId: string
  identity: { id: number; name?: string; sessionName: string }
  remoteCwd: string
  socketName?: string
  endpoint: SshEndpoint
  runner: DevboxSshRunner
  markerInput: TerminalMarkerAttachInput
  terminalMarkers: boolean
  reconnect: boolean
  loginRelay?: DevboxShellLoginRelayFactory
  deviceLabel?: string
  /** `shell new --run`: typed into the session once before attaching; never set for attach/resume. */
  initialInput?: string
  /** Hub-local profiles attach with a local shell instead of ssh; the relay is pointless there. */
  local?: boolean
  interactive?: (remoteCommand: string, options?: { remoteForwards?: readonly string[] }) => Promise<number>
}

export async function runDevboxShellWithLoginRelay(
  input: DevboxShellRelayAttachInput
): Promise<DevboxShellReconnectOutcome> {
  let session: DevboxShellLoginRelaySession | undefined
  if (input.loginRelay !== undefined && input.local !== true) {
    try {
      session = await input.loginRelay({ runner: input.runner, deviceLabel: input.deviceLabel ?? input.endpoint.host })
    } catch {
      session = undefined
    }
  }
  const reconnect = input.reconnect && input.terminalMarkers && isDevboxShellReconnectEnabled(process.env, process.stdin, process.stderr)
  const markerOptions = { terminalMarkers: input.terminalMarkers }
  try {
    return await runDevboxShellWithReconnect({
      attempt: async () => {
        let prepared: RelayAttempt | undefined
        try {
          prepared = await session?.prepareAttempt()
        } catch {
          prepared = undefined
        }
        const relay = prepared?.relay
        const command = buildDevboxShellAttachCommand(
          input.identity.sessionName,
          input.remoteCwd,
          input.profileId,
          input.socketName,
          relay,
          input.initialInput
        )
        const interactive = input.interactive
        const options = {
          terminalMarkers: input.terminalMarkers,
          reconnect,
          ...(prepared === undefined ? {} : { remoteForwards: prepared.remoteForwards }),
          ...(interactive === undefined ? {} : { run: (_endpoint: SshEndpoint, remoteCommand: string, runOptions?: { remoteForwards?: readonly string[] }) => interactive(remoteCommand, runOptions) })
        }
        return runDevboxShellInteractive(input.endpoint, command, input.markerInput, options)
      },
      label: formatDevboxShellReconnectLabel({
        id: input.identity.id,
        name: input.identity.name,
        username: input.endpoint.username,
        host: input.endpoint.host
      }),
      enabled: reconnect,
      onReconnectWait: (wait) => { writeShellReconnectingMarker(input.markerInput, wait, markerOptions) },
      onAbandon: () => { writeShellAbandonedMarker(input.markerInput, SSH_TRANSPORT_FAILURE_EXIT_CODE, markerOptions) }
    })
  } finally {
    try {
      await session?.stop()
    } catch {
      // Relay teardown is best effort and must not replace the shell exit code.
    }
  }
}

export function createDevboxShellLoginRelayFactory(options: {
  env: NodeJS.ProcessEnv
  stateRoot: string
  disabled: boolean
}): DevboxShellLoginRelayFactory {
  return async ({ runner, deviceLabel }) => {
    if (!isDevboxLoginRelayEnabled(options.env, options.disabled)) {
      return undefined
    }
    let ports: number[]
    try {
      ports = resolveDevboxLoginRelayPorts(options.env)
    } catch {
      return undefined
    }
    let relay: DevboxLoginRelayHandle
    try {
      relay = await startDevboxLoginRelay({
        forward: (script, timeoutMs) => runner.script(script, timeoutMs),
        ports,
        deviceLabel,
        log: (line) => appendRelayLog(options.stateRoot, line)
      })
    } catch {
      return undefined
    }
    let failed = false
    return {
      prepareAttempt: async (): Promise<RelayAttempt | undefined> => {
        if (failed) {
          return undefined
        }
        try {
          const dir = parseDevboxLoginRelayPrepareOutput(await runner.script(buildDevboxLoginRelayPrepareScript(), 15_000))
          const socketPath = `${dir}/${randomBytes(8).toString('hex')}.sock`
          if (Buffer.byteLength(socketPath, 'utf8') >= 104) {
            throw new Error('Login relay socket path is too long')
          }
          const token = randomBytes(16).toString('hex')
          relay.setToken?.(token)
          return {
            remoteForwards: [`${socketPath}:127.0.0.1:${relay.controlPort}`],
            relay: { watcherScript: buildDevboxLoginRelayWatcherScript({ socketPath, token, ports }) }
          }
        } catch {
          failed = true
          return undefined
        }
      },
      stop: () => relay.stop()
    }
  }
}

function appendRelayLog(stateRoot: string, line: string): void {
  try {
    const directory = join(stateRoot, 'logs')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    appendFileSync(join(directory, 'login-relay.log'), `${line}\n`, { mode: 0o600 })
  } catch {
    // Relay logging is best effort and must never affect an interactive shell.
  }
}

