import type { SshEndpoint } from '../shared/ssh-runner-types'
import { runSystemSshInteractive } from '../ssh/system-ssh-runner'
import { DEVBOX_VERSION } from './version'
import {
  buildAttachMarker,
  buildDetachMarker,
  buildStateMarker,
  detachReasonForExitCode,
  writeTerminalMarker,
  type TerminalMarkerAttachInput,
  type TerminalMarkerDetachInput,
  type TerminalMarkerStateInput,
  type TerminalMarkerStream
} from './shell-terminal-marker'
import type { DevboxShellSessionIdentity } from './shell-sessions'

export type DevboxShellInteractiveOptions = {
  stream?: TerminalMarkerStream
  env?: NodeJS.ProcessEnv
  terminalMarkers?: boolean
  remoteForwards?: readonly string[]
  /** The caller retries a transport failure (ssh 255): its detach then says `connection-lost`. */
  reconnect?: boolean
  run?: typeof runSystemSshInteractive
}

export async function runDevboxShellInteractive(
  endpoint: SshEndpoint,
  remoteCommand: string,
  attachInput: TerminalMarkerAttachInput,
  options: DevboxShellInteractiveOptions = {}
): Promise<number> {
  const { stream, env } = markerTarget(options)
  let attachMarker: string | undefined
  try {
    attachMarker = buildAttachMarker(attachInput)
  } catch {
    // Marker emission is an optional host integration and must never block attach.
  }
  writeTerminalMarker(stream, attachMarker, env)
  // A rejected spawn keeps this default; a settled child replaces it with its exit code.
  let detachInput: TerminalMarkerDetachInput = {
    profileId: attachInput.profileId,
    sessionName: attachInput.sessionName,
    reason: 'error'
  }
  try {
    const sshOptions = {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.remoteForwards === undefined ? {} : { remoteForwards: options.remoteForwards })
    }
    const exitCode = await (options.run ?? runSystemSshInteractive)(endpoint, remoteCommand, sshOptions)
    detachInput = {
      ...detachInput,
      reason: detachReasonForExitCode(exitCode, options.reconnect === true),
      ...(Number.isSafeInteger(exitCode) ? { exitCode } : {})
    }
    return exitCode
  } finally {
    let detachMarker: string | undefined
    try {
      detachMarker = buildDetachMarker(detachInput)
    } catch {
      // Detach remains best effort when the session identity is not representable.
    }
    writeTerminalMarker(stream, detachMarker, env)
  }
}

type MarkerTargetOptions = Pick<DevboxShellInteractiveOptions, 'stream' | 'env' | 'terminalMarkers'>

function markerTarget(options: MarkerTargetOptions): { stream: TerminalMarkerStream; env: NodeJS.ProcessEnv } {
  return {
    stream: options.stream ?? process.stdout,
    env: options.terminalMarkers === false
      ? { ...process.env, ...options.env, DEVBOX_TERMINAL_MARKERS: '0' }
      : options.env ?? process.env
  }
}

/** The reconnect loop's wait started: `state:reconnecting` between the detach and the next attach. */
export function writeShellReconnectingMarker(
  identity: Pick<TerminalMarkerAttachInput, 'profileId' | 'sessionName'>,
  wait: { attempt: number; retryInMs: number },
  options: MarkerTargetOptions = {}
): void {
  const input: TerminalMarkerStateInput = {
    profileId: identity.profileId,
    sessionName: identity.sessionName,
    state: 'reconnecting',
    attempt: wait.attempt,
    retryInMs: wait.retryInMs
  }
  writeOptionalMarker(() => buildStateMarker(input), options)
}

/**
 * The user abandoned the reconnect wait: the `connection-lost` detach already sent promised a
 * retry that will not come, so close it with a final `exit` detach.
 */
export function writeShellAbandonedMarker(
  identity: Pick<TerminalMarkerAttachInput, 'profileId' | 'sessionName'>,
  exitCode: number,
  options: MarkerTargetOptions = {}
): void {
  writeOptionalMarker(() => buildDetachMarker({
    profileId: identity.profileId,
    sessionName: identity.sessionName,
    reason: 'exit',
    exitCode
  }), options)
}

function writeOptionalMarker(build: () => string, options: MarkerTargetOptions): void {
  let marker: string | undefined
  try {
    marker = build()
  } catch {
    // Markers are an optional host integration; an unrepresentable one is skipped.
  }
  const { stream, env } = markerTarget(options)
  writeTerminalMarker(stream, marker, env)
}

export function buildShellAttachMarkerInput(
  profileId: string,
  identity: DevboxShellSessionIdentity,
  endpoint: SshEndpoint,
  socketName: string | undefined,
  isPhi: boolean,
  remoteCwd: string | undefined
): TerminalMarkerAttachInput {
  return {
    profileId,
    sessionId: identity.id,
    sessionName: identity.sessionName,
    ...(identity.name === undefined || identity.name.length > 64 ? {} : { friendlyName: identity.name }),
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    ...(remoteCwd === undefined ? {} : { remoteCwd }),
    program: isPhi ? 'phi' : 'shell',
    ...(socketName === undefined ? {} : { tmuxSocket: socketName }),
    cliVersion: DEVBOX_VERSION
  }
}
