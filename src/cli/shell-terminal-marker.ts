import { isAbsolute } from 'node:path'
import { SSH_TRANSPORT_FAILURE_EXIT_CODE } from './shell-reconnect'

const MARKER_PREFIX = '\u001b]9998;devbox-terminal;'
const MARKER_SUFFIX = '\u0007'
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SESSION_NAME_PATTERN = /^devbox-([a-z0-9][a-z0-9-]{0,63})-([1-9][0-9]*)(?:-([A-Za-z0-9._-]+))?$/u
const FRIENDLY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u
const HOST_WHITESPACE_PATTERN = /\s/u
const DETACH_REASONS: ReadonlySet<string> = new Set(['exit', 'connection-lost', 'error'])

export type TerminalMarkerStream = {
  isTTY?: boolean
  write(chunk: string): boolean
}

export type TerminalMarkerAttachInput = {
  profileId: string
  sessionId: number
  sessionName: string
  friendlyName?: string
  host: string
  port: number
  username: string
  remoteCwd?: string
  program: 'phi' | 'shell'
  tmuxSocket?: string
  cliVersion: string
}

/**
 * Why an attach ended (CLI >= 0.6.9). `exit`: the ssh/tmux client ended normally (exit 0,
 * including a tmux detach) or the user abandoned the reconnect wait. `connection-lost`: the
 * transport dropped (ssh exit 255) and the CLI is about to retry. `error`: anything else,
 * including a dropped transport the CLI will not retry.
 */
export type TerminalMarkerDetachReason = 'exit' | 'connection-lost' | 'error'

export type TerminalMarkerDetachInput = {
  profileId: string
  sessionName: string
  reason?: TerminalMarkerDetachReason
  exitCode?: number
}

/** The reconnect loop announcing itself between a detach and the next attach (CLI >= 0.6.9). */
export type TerminalMarkerStateInput = {
  profileId: string
  sessionName: string
  state: 'reconnecting'
  /** 1-based reconnect attempt about to run (the original attach is not counted). */
  attempt?: number
  retryInMs?: number
}

export function buildAttachMarker(input: TerminalMarkerAttachInput): string {
  validateAttachInput(input)
  return serializeMarker({
    v: 1,
    event: 'attach',
    profileId: input.profileId,
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    ...(input.friendlyName === undefined ? {} : { friendlyName: input.friendlyName }),
    host: input.host,
    port: input.port,
    username: input.username,
    ...(input.remoteCwd === undefined ? {} : { remoteCwd: input.remoteCwd }),
    program: input.program,
    ...(input.tmuxSocket === undefined ? {} : { tmuxSocket: input.tmuxSocket }),
    cliVersion: input.cliVersion
  })
}

export function buildDetachMarker(input: TerminalMarkerDetachInput): string {
  validateProfileId(input.profileId)
  validateSessionName(input.profileId, input.sessionName)
  if (input.reason !== undefined && !DETACH_REASONS.has(input.reason)) {
    throw new Error('terminal marker detach reason is invalid')
  }
  if (input.exitCode !== undefined && !Number.isSafeInteger(input.exitCode)) {
    throw new Error('terminal marker exitCode must be an integer')
  }
  return serializeMarker({
    v: 1,
    event: 'detach',
    profileId: input.profileId,
    sessionName: input.sessionName,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode })
  })
}

export function buildStateMarker(input: TerminalMarkerStateInput): string {
  validateProfileId(input.profileId)
  validateSessionName(input.profileId, input.sessionName)
  if (input.state !== 'reconnecting') {
    throw new Error('terminal marker state is invalid')
  }
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) {
    throw new Error('terminal marker attempt must be a positive integer')
  }
  if (input.retryInMs !== undefined && (!Number.isSafeInteger(input.retryInMs) || input.retryInMs < 0)) {
    throw new Error('terminal marker retryInMs must be a non-negative integer')
  }
  return serializeMarker({
    v: 1,
    event: 'state',
    profileId: input.profileId,
    sessionName: input.sessionName,
    state: input.state,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.retryInMs === undefined ? {} : { retryInMs: input.retryInMs })
  })
}

/**
 * Map an interactive attach's exit code to a detach reason. A transport failure (ssh 255) is
 * `connection-lost` only when the caller will retry it; otherwise the attach really ended.
 */
export function detachReasonForExitCode(
  exitCode: number,
  reconnects: boolean
): TerminalMarkerDetachReason {
  if (exitCode === 0) {return 'exit'}
  return exitCode === SSH_TRANSPORT_FAILURE_EXIT_CODE && reconnects ? 'connection-lost' : 'error'
}

export function writeTerminalMarker(
  stream: TerminalMarkerStream,
  marker: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (marker === undefined || stream.isTTY !== true || env.DEVBOX_TERMINAL_MARKERS === '0') {
    return false
  }
  try {
    stream.write(`${MARKER_PREFIX}${marker}${MARKER_SUFFIX}`)
    return true
  } catch {
    return false
  }
}

function validateAttachInput(input: TerminalMarkerAttachInput): void {
  validateProfileId(input.profileId)
  validateSessionName(input.profileId, input.sessionName)
  if (!Number.isSafeInteger(input.sessionId) || input.sessionId < 1) {
    throw new Error('terminal marker sessionId must be a positive integer')
  }
  const sessionMatch = SESSION_NAME_PATTERN.exec(input.sessionName)
  if (sessionMatch?.[2] !== String(input.sessionId)) {
    throw new Error('terminal marker sessionId must match sessionName')
  }
  if (input.friendlyName !== undefined) {
    validateFriendlyName(input.friendlyName)
    if (sessionMatch?.[3] !== input.friendlyName) {
      throw new Error('terminal marker friendlyName must match sessionName')
    }
  }
  validateText(input.host, 'host', 253)
  if (HOST_WHITESPACE_PATTERN.test(input.host)) {
    throw new Error('terminal marker host must be an IP address or hostname')
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error('terminal marker port must be between 1 and 65535')
  }
  validateText(input.username, 'username', 64)
  if (HOST_WHITESPACE_PATTERN.test(input.username)) {
    throw new Error('terminal marker username must not contain whitespace')
  }
  if (input.remoteCwd !== undefined) {
    validateText(input.remoteCwd, 'remoteCwd', 512)
    if (!isAbsolute(input.remoteCwd)) {
      throw new Error('terminal marker remoteCwd must be an absolute path')
    }
  }
  if (input.program !== 'phi' && input.program !== 'shell') {
    throw new Error('terminal marker program must be phi or shell')
  }
  if (input.tmuxSocket !== undefined) {
    validateText(input.tmuxSocket, 'tmuxSocket', Number.MAX_SAFE_INTEGER)
    if (HOST_WHITESPACE_PATTERN.test(input.tmuxSocket)) {
      throw new Error('terminal marker tmuxSocket must not contain whitespace')
    }
  }
  validateText(input.cliVersion, 'cliVersion', Number.MAX_SAFE_INTEGER)
}

function validateProfileId(value: string): void {
  validateText(value, 'profileId', 64)
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw new Error('terminal marker profileId is invalid')
  }
}

function validateSessionName(profileId: string, value: string): void {
  validateText(value, 'sessionName', 128)
  const match = SESSION_NAME_PATTERN.exec(value)
  if (match === null || match[1] !== profileId) {
    throw new Error('terminal marker sessionName is not canonical')
  }
  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('terminal marker sessionName has an invalid id')
  }
}

function validateFriendlyName(value: string): void {
  validateText(value, 'friendlyName', 64)
  if (!FRIENDLY_NAME_PATTERN.test(value)) {
    throw new Error('terminal marker friendlyName is invalid')
  }
}

function validateText(value: string, field: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`terminal marker ${field} has an invalid length`)
  }
  if (containsControlCharacter(value)) {
    throw new Error(`terminal marker ${field} contains a control character`)
  }
}

type MarkerPayload = Record<string, string | number>

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function serializeMarker(payload: MarkerPayload): string {
  const serialized = JSON.stringify(payload)
  if (serialized.includes('\u001b') || serialized.includes('\u0007')) {
    throw new Error('terminal marker JSON contains a forbidden control character')
  }
  if (Buffer.byteLength(serialized, 'utf8') > 2_048) {
    throw new Error('terminal marker JSON exceeds 2048 bytes')
  }
  return serialized
}
