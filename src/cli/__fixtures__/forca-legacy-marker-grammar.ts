/**
 * Test-only copy of the older Forca marker grammar from before native devbox tabs. Logic is unchanged; only formatting follows this repo's lint. It proves
 * the 0.6.9 additions are invisible there: `state` events parse to null (ignored) and the new
 * detach keys are dropped by the known-key copy, so its attach/detach handling is unchanged.
 */

const DEVBOX_TERMINAL_MARKER_MAX_JSON_BYTES = 2048
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SESSION_NAME_PATTERN = /^devbox-[a-z0-9-]+-\d+(?:-[a-z0-9-]+)?$/
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
const IPV6_PATTERN = /^(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}$/

export type LegacyForcaMarker = Record<string, unknown> & { v: 1; event: 'attach' | 'detach' }

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHost(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 253 &&
    (HOSTNAME_PATTERN.test(value) || IPV6_PATTERN.test(value))
}

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535
}

function isBoundedString(value: unknown, max: number, allowEmpty = true): boolean {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max
}

function validateOptionalFields(record: Record<string, unknown>): boolean {
  if (hasOwn(record, 'friendlyName') && !isBoundedString(record.friendlyName, 64)) {return false}
  if (hasOwn(record, 'host') && !isHost(record.host)) {return false}
  if (hasOwn(record, 'port') && !isPort(record.port)) {return false}
  if (hasOwn(record, 'username') && !isBoundedString(record.username, 64, false)) {return false}
  if (hasOwn(record, 'remoteCwd') && (!isBoundedString(record.remoteCwd, 512, false) || !String(record.remoteCwd).startsWith('/'))) {
    return false
  }
  if (hasOwn(record, 'program') && record.program !== 'phi' && record.program !== 'shell') {return false}
  if (hasOwn(record, 'tmuxSocket') && !isBoundedString(record.tmuxSocket, 128)) {return false}
  if (hasOwn(record, 'cliVersion') && !isBoundedString(record.cliVersion, 32)) {return false}
  if (hasOwn(record, 'sessionId') && (!Number.isSafeInteger(record.sessionId) || (record.sessionId as number) <= 0)) {
    return false
  }
  return true
}

export function parseLegacyForcaMarkerPayload(payload: string): LegacyForcaMarker | null {
  if (new TextEncoder().encode(payload).byteLength > DEVBOX_TERMINAL_MARKER_MAX_JSON_BYTES) {return null}
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(value) || value.v !== 1 || (value.event !== 'attach' && value.event !== 'detach')) {return null}
  if (
    typeof value.profileId !== 'string' ||
    !PROFILE_ID_PATTERN.test(value.profileId) ||
    typeof value.sessionName !== 'string' ||
    value.sessionName.length > 128 ||
    !SESSION_NAME_PATTERN.test(value.sessionName) ||
    !validateOptionalFields(value)
  ) {
    return null
  }
  if (
    value.event === 'attach' &&
    (!hasOwn(value, 'sessionId') || !Number.isSafeInteger(value.sessionId) || (value.sessionId as number) <= 0 ||
      !hasOwn(value, 'host') || !isHost(value.host) || !hasOwn(value, 'port') || !isPort(value.port) ||
      !hasOwn(value, 'username') || !isBoundedString(value.username, 64, false))
  ) {
    return null
  }
  const sanitized: Record<string, unknown> = {
    v: 1,
    event: value.event,
    profileId: value.profileId,
    sessionName: value.sessionName
  }
  for (const key of ['sessionId', 'friendlyName', 'host', 'port', 'username', 'remoteCwd', 'program', 'tmuxSocket', 'cliVersion']) {
    if (hasOwn(value, key)) {sanitized[key] = value[key]}
  }
  return sanitized as LegacyForcaMarker
}
