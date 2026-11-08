const SESSION_COMPONENT_MAX_LENGTH = 96
export const DEVBOX_SHELL_SESSION_ID_PATTERN = /^[1-9][0-9]*$/u
const SESSION_NAME_PATTERN = /^([1-9][0-9]*)(?:-([A-Za-z0-9._-]+))?$/u

export type DevboxShellSessionIdentity = {
  id: number
  name?: string
  sessionName: string
}

export type DevboxLegacyShellSessionIdentity = {
  name: string
  sessionName: string
}

export type DevboxShellSession = DevboxShellSessionIdentity & {
  created: number
  attached: boolean
  lastUsed: number
  currentCommand: string
  currentTitle: string
  mostRecent: boolean
  /** Remote working directory of the active pane; present when listed by the one-round-trip probe. */
  cwd?: string
}

export type DevboxShellListResult = {
  profileId: string
  mostRecentId: number | null
  sessions: readonly DevboxShellSession[]
}

export type DevboxShellAttachResult = DevboxShellSessionIdentity & {
  profileId: string
  exitCode: number
  reconnectAttempts?: number
}

export type DevboxShellKillResult = {
  profileId: string
  id?: number
  name?: string
  sessionName: string
  killed: true
}

export type DevboxShellKillAllResult = {
  profileId: string
  count: number
  sessions: readonly string[]
  killed: true
}

export type DevboxShellKillUnattachedResult = DevboxShellKillAllResult

export function sanitizeDevboxShellComponent(value: string, label = 'shell name'): string {
  const sanitized = value.trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, SESSION_COMPONENT_MAX_LENGTH)
  if (sanitized.length === 0) {throw new Error(`${label} must contain at least one safe character.`)}
  return sanitized
}

export function devboxShellSessionPrefix(profileId: string): string {
  return `devbox-${sanitizeDevboxShellComponent(profileId, 'profile id')}-`
}

export function buildDevboxShellSessionName(profileId: string, id: number, name?: string): string {
  if (!Number.isSafeInteger(id) || id < 1) {throw new Error('shell session id must be a positive integer.')}
  const friendlyName = name === undefined ? undefined : sanitizeDevboxShellComponent(name)
  return `${devboxShellSessionPrefix(profileId)}${id}${friendlyName === undefined ? '' : `-${friendlyName}`}`
}

/**
 * Build the v0.1.5 name shape. It is intentionally not used for creation: old
 * names are a cleanup-only compatibility surface.
 */
export function buildDevboxLegacyShellSessionName(profileId: string, name: string): string {
  return `${devboxShellSessionPrefix(profileId)}${sanitizeDevboxShellComponent(name)}`
}

export function parseDevboxShellSessionName(profileId: string, sessionName: string): DevboxShellSessionIdentity | undefined {
  const prefix = devboxShellSessionPrefix(profileId)
  if (!sessionName.startsWith(prefix)) {return undefined}
  const match = SESSION_NAME_PATTERN.exec(sessionName.slice(prefix.length))
  if (!match) {return undefined}
  const id = Number(match[1])
  const name = match[2]
  if (!Number.isSafeInteger(id) || id < 1) {return undefined}
  try {
    if (buildDevboxShellSessionName(profileId, id, name) !== sessionName) {return undefined}
  } catch {
    return undefined
  }
  return { id, ...(name === undefined ? {} : { name }), sessionName }
}

/**
 * Recognize only the old, name-only v0.1.5 namespace. A suffix that can be a
 * canonical numeric id is deliberately excluded because it is ambiguous and
 * must not be deleted as a legacy resource.
 */
export function parseDevboxLegacyShellSessionName(
  profileId: string,
  sessionName: string
): DevboxLegacyShellSessionIdentity | undefined {
  const prefix = devboxShellSessionPrefix(profileId)
  if (!sessionName.startsWith(prefix)) {return undefined}
  const name = sessionName.slice(prefix.length)
  if (name.length === 0 || parseDevboxShellSessionName(profileId, sessionName)) {return undefined}
  try {
    if (buildDevboxLegacyShellSessionName(profileId, name) !== sessionName) {return undefined}
  } catch {
    return undefined
  }
  return { name, sessionName }
}

export function assertDevboxShellSessionName(profileId: string, sessionName: string): void {
  const prefix = devboxShellSessionPrefix(profileId)
  if (!sessionName.startsWith(prefix)) {
    throw new Error(`Refusing tmux session outside the Devbox prefix: ${sessionName}`)
  }
  if (!parseDevboxShellSessionName(profileId, sessionName)) {
    throw new Error(`Refusing tmux session outside the Devbox naming policy: ${sessionName}`)
  }
}

/**
 * Validate a cleanup target across the canonical and v0.1.5 transition names.
 * Legacy names are cleanup-only and must never be accepted for creation.
 */
export function assertDevboxOwnedShellSessionName(profileId: string, sessionName: string): void {
  const prefix = devboxShellSessionPrefix(profileId)
  if (!sessionName.startsWith(prefix)) {
    throw new Error(`Refusing tmux session outside the Devbox prefix: ${sessionName}`)
  }
  if (!parseDevboxShellSessionName(profileId, sessionName) && !parseDevboxLegacyShellSessionName(profileId, sessionName)) {
    throw new Error(`Refusing tmux session outside the Devbox naming policy: ${sessionName}`)
  }
}

export function allocateDevboxShellId(sessions: readonly Pick<DevboxShellSessionIdentity, 'id'>[]): number {
  const used = new Set(sessions.map((session) => session.id))
  for (let id = 1; id <= Number.MAX_SAFE_INTEGER; id += 1) {
    if (!used.has(id)) {return id}
  }
  throw new Error('No available Devbox shell session id.')
}

export function createNextDevboxShellIdentity(
  profileId: string,
  sessions: readonly DevboxShellSession[],
  name?: string
): DevboxShellSessionIdentity {
  const id = allocateDevboxShellId(sessions)
  return { id, ...(name === undefined ? {} : { name: sanitizeDevboxShellComponent(name) }), sessionName: buildDevboxShellSessionName(profileId, id, name) }
}

export function resolveDevboxShellTarget(
  target: string,
  sessions: readonly DevboxShellSession[]
): DevboxShellSessionIdentity {
  const exactSession = sessions.find((session) => session.sessionName === target)
  if (exactSession) {return exactSession}
  const numericTarget = DEVBOX_SHELL_SESSION_ID_PATTERN.test(target) ? Number(target) : undefined
  const match = numericTarget === undefined
    ? findSessionByName(target, sessions)
    : sessions.find((session) => session.id === numericTarget)
  if (match) {return match}
  const existing = sessions.length === 0
    ? 'none'
    : sessions.map((session) => `${session.id}${session.name === undefined ? '' : ` (${session.name})`}`).join(', ')
  throw new Error(`No Devbox shell session matches '${target}'. Existing sessions: ${existing}`)
}

function findSessionByName(
  target: string,
  sessions: readonly DevboxShellSession[]
): DevboxShellSession | undefined {
  let sanitized: string
  try {
    sanitized = sanitizeDevboxShellComponent(target)
  } catch {
    return undefined
  }
  return sessions.find((session) => session.name === sanitized)
}

export function selectMostRecentDevboxShellSession(sessions: readonly DevboxShellSession[]): DevboxShellSession | undefined {
  return sessions.reduce<DevboxShellSession | undefined>((mostRecent, session) => {
    if (!mostRecent) {return session}
    const leftTimestamp = session.lastUsed || session.created
    const rightTimestamp = mostRecent.lastUsed || mostRecent.created
    if (leftTimestamp !== rightTimestamp) {return leftTimestamp > rightTimestamp ? session : mostRecent}
    if (session.created !== mostRecent.created) {return session.created > mostRecent.created ? session : mostRecent}
    return session.id > mostRecent.id ? session : mostRecent
  }, undefined)
}

export function parseDevboxShellSessionLine(profileId: string, line: string): DevboxShellSession | undefined {
  const trimmed = line.trimEnd()
  if (trimmed.length === 0) {return undefined}
  const fields = trimmed.split('\t')
  if (fields.length < 4) {return undefined}
  const identity = parseDevboxShellSessionName(profileId, fields[0] ?? '')
  if (!identity) {return undefined}
  const created = parseTimestamp(fields[1])
  // Only the exact tmux value 0 is safe to classify as detached. Unknown or
  // malformed metadata must never widen the kill set.
  const attached = fields[2] !== '0'
  const hasActivityAndTitle = fields.length >= 6
  const lastUsed = hasActivityAndTitle ? parseTimestamp(fields[3]) : created
  const currentCommand = hasActivityAndTitle ? (fields[4] ?? '') : fields.slice(3).join('\t')
  const currentTitle = hasActivityAndTitle ? fields.slice(5).join('\t') : ''
  return { ...identity, created, attached, lastUsed, currentCommand, currentTitle, mostRecent: false }
}

function parseTimestamp(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}
