/**
 * Test-only copy of the CURRENT Forca marker grammar (Forca `src/shared/devbox-attach-marker.ts`
 * `parseDevboxTerminalMarkerPayload` plus the helpers it uses from
 * `src/shared/devbox-terminal-identity.ts`, branch feat/native-devbox-tabs). Logic is unchanged;
 * only formatting follows this repo's lint. Re-copy it when Forca's grammar changes: the
 * round-trip test proves every marker this CLI emits is accepted there field for field.
 */

const DEVBOX_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SESSION_TAIL_PATTERN = /^([1-9][0-9]*)(?:-([A-Za-z0-9._-]{1,64}))?$/
const MAX_SESSION_NAME_LENGTH = 128
const MAX_JSON_BYTES = 2048
// oxlint-disable-next-line no-control-regex -- the control range is the thing rejected.
const UNSAFE_TOKEN_CHARS = /[\s\x00-\x1f\x7f]/

export type ForcaAttachMarker = {
  v: 1
  event: 'attach'
  profileId: string
  sessionId: number
  sessionName: string
  friendlyName?: string
  host: string
  port: number
  username: string
  remoteCwd?: string
  program?: 'phi' | 'shell'
  tmuxSocket?: string
  cliVersion?: string
}

export type ForcaDetachMarker = {
  v: 1
  event: 'detach'
  profileId: string
  sessionName: string
  reason?: 'exit' | 'connection-lost' | 'error'
  exitCode?: number
}

export type ForcaStateMarker = {
  v: 1
  event: 'state'
  profileId: string
  sessionName: string
  state: 'reconnecting'
  attempt?: number
  retryInMs?: number
}

export type ForcaMarker = ForcaAttachMarker | ForcaDetachMarker | ForcaStateMarker

function parseDevboxSessionName(
  sessionName: string,
  profileId: string
): { profileId: string; sessionId: number; friendlyName?: string } | null {
  if (sessionName.length === 0 || sessionName.length > MAX_SESSION_NAME_LENGTH) {return null}
  const prefix = `devbox-${profileId}-`
  if (!DEVBOX_PROFILE_ID_PATTERN.test(profileId) || !sessionName.startsWith(prefix)) {return null}
  const tail = SESSION_TAIL_PATTERN.exec(sessionName.slice(prefix.length))
  if (!tail) {return null}
  const sessionId = Number(tail[1])
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {return null}
  const friendlyName = tail[2]
  return { profileId, sessionId, ...(friendlyName ? { friendlyName } : {}) }
}

function isDevboxToken(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !UNSAFE_TOKEN_CHARS.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function token(value: unknown, max: number): string | undefined {
  return isDevboxToken(value, max) ? value : undefined
}

function positiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
    ? value as number
    : undefined
}

function pickAttach(record: Record<string, unknown>, profileId: string, sessionName: string): ForcaAttachMarker | null {
  const parsed = parseDevboxSessionName(sessionName, profileId)
  const sessionId = positiveInt(record.sessionId)
  const host = token(record.host, 253)
  const port = positiveInt(record.port, 65535)
  const username = token(record.username, 64)
  if (!parsed || sessionId !== parsed.sessionId || !host || !port || !username) {return null}
  const remoteCwd = token(record.remoteCwd, 512)
  const tmuxSocket = token(record.tmuxSocket, 128)
  const cliVersion = token(record.cliVersion, 64)
  const friendlyName = parsed.friendlyName
  return {
    v: 1,
    event: 'attach',
    profileId,
    sessionId,
    sessionName,
    ...(friendlyName ? { friendlyName } : {}),
    host,
    port,
    username,
    ...(remoteCwd?.startsWith('/') ? { remoteCwd } : {}),
    ...(record.program === 'phi' || record.program === 'shell' ? { program: record.program } : {}),
    ...(tmuxSocket ? { tmuxSocket } : {}),
    ...(cliVersion ? { cliVersion } : {})
  }
}

export function parseForcaMarkerPayload(payload: string): ForcaMarker | null {
  if (payload.length > MAX_JSON_BYTES || new TextEncoder().encode(payload).byteLength > MAX_JSON_BYTES) {return null}
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(value) || value.v !== 1) {return null}
  const profileId = typeof value.profileId === 'string' && DEVBOX_PROFILE_ID_PATTERN.test(value.profileId)
    ? value.profileId
    : null
  const sessionName = typeof value.sessionName === 'string' ? value.sessionName : null
  if (!profileId || !sessionName || !parseDevboxSessionName(sessionName, profileId)) {return null}
  switch (value.event) {
    case 'attach':
      return pickAttach(value, profileId, sessionName)
    case 'detach': {
      const reason = value.reason === 'exit' || value.reason === 'connection-lost' || value.reason === 'error'
        ? value.reason
        : undefined
      const exitCode = Number.isInteger(value.exitCode) ? value.exitCode as number : undefined
      return {
        v: 1,
        event: 'detach',
        profileId,
        sessionName,
        ...(reason ? { reason } : {}),
        ...(exitCode === undefined ? {} : { exitCode })
      }
    }
    case 'state': {
      if (value.state !== 'reconnecting') {return null}
      const attempt = positiveInt(value.attempt)
      const retryInMs = Number.isSafeInteger(value.retryInMs) && (value.retryInMs as number) >= 0
        ? value.retryInMs as number
        : undefined
      return {
        v: 1,
        event: 'state',
        profileId,
        sessionName,
        state: 'reconnecting',
        ...(attempt === undefined ? {} : { attempt }),
        ...(retryInMs === undefined ? {} : { retryInMs })
      }
    }
    default:
      return null
  }
}
