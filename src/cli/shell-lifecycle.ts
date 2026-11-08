import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import {
  DEVBOX_SHELL_SESSION_ID_PATTERN,
  allocateDevboxShellId,
  buildDevboxShellSessionName,
  parseDevboxLegacyShellSessionName,
  parseDevboxShellSessionLine,
  sanitizeDevboxShellComponent,
  selectMostRecentDevboxShellSession
} from './shell-sessions'
import type {
  DevboxLegacyShellSessionIdentity,
  DevboxShellListResult,
  DevboxShellSession,
  DevboxShellSessionIdentity
} from './shell-sessions'
import { buildDevboxShellListCommand, devboxShellSocketName, type DevboxShellSocket } from './shell-tmux'

export type OwnedCanonicalShell = {
  canonical: true
  session: DevboxShellSession
  socketName: DevboxShellSocket
}

export type OwnedLegacyShell = {
  canonical: false
  session: DevboxLegacyShellSessionIdentity
  /** Only an exact tmux session_attached value of 0 is detached. */
  attached: boolean
  socketName: DevboxShellSocket
}

export type OwnedShell = OwnedCanonicalShell | OwnedLegacyShell

/** Select the socket that the caller observed before lifecycle discovery. */
export type DevboxShellSocketSelection = {
  socketName: DevboxShellSocket
}

export async function listOwnedDevboxShellSessions(
  profileId: string,
  runner: DevboxSshRunner,
  timeoutMs?: number
): Promise<OwnedShell[]> {
  const locations: readonly DevboxShellSocket[] = [privateSocket(profileId), undefined]
  const sessions: OwnedShell[] = []
  for (const socketName of locations) {
    let output: string
    try {
      output = await runner.command(buildDevboxShellListCommand(socketName), timeoutMs)
    } catch {
      // A missing private/default tmux server is an empty namespace. Continue
      // to the other socket so legacy sessions remain reachable.
      continue
    }
    sessions.push(...parseOwnedDevboxShellOutput(profileId, output, socketName))
  }
  return sessions
}

/** Parse one tmux list-sessions output (one socket) into the Devbox-owned shells of a profile. */
export function parseOwnedDevboxShellOutput(
  profileId: string,
  output: string,
  socketName: DevboxShellSocket
): OwnedShell[] {
  const sessions: OwnedShell[] = []
  for (const line of output.split('\n')) {
    const canonical = parseDevboxShellSessionLine(profileId, line)
    if (canonical !== undefined) {
      sessions.push({ canonical: true, session: canonical, socketName })
      continue
    }
    const legacy = parseLegacySessionLine(profileId, line)
    if (legacy !== undefined) {
      sessions.push({
        canonical: false,
        session: { name: legacy.name, sessionName: legacy.sessionName },
        attached: legacy.attached,
        socketName
      })
    }
  }
  return sessions
}

/** The `shell ls` view of owned shells: canonical sessions by id, the most recent one marked. */
export function buildDevboxShellListResult(profileId: string, sessions: readonly OwnedShell[]): DevboxShellListResult {
  const mostRecent = selectMostRecentCanonicalSession(sessions)?.session
  const marked = canonicalSessions(sessions).map((session) => ({
    ...session,
    mostRecent: session.sessionName === mostRecent?.sessionName
  }))
  return { profileId, mostRecentId: mostRecent?.id ?? null, sessions: marked }
}

export function canonicalSessions(sessions: readonly OwnedShell[]): DevboxShellSession[] {
  return canonicalOwnedSessions(sessions)
    .map((session) => session.session)
    .sort((left, right) => left.id - right.id)
}

export function selectMostRecentCanonicalSession(
  sessions: readonly OwnedShell[]
): OwnedCanonicalShell | undefined {
  const canonical = canonicalOwnedSessions(sessions)
  const selected = selectMostRecentDevboxShellSession(canonical.map((session) => session.session))
  return canonical.find((session) => session.session.sessionName === selected?.sessionName)
}

export function createNextShellIdentity(
  profileId: string,
  sessions: readonly DevboxShellSession[],
  name?: string
): DevboxShellSessionIdentity {
  const id = allocateDevboxShellId(sessions)
  return {
    id,
    ...(name === undefined ? {} : { name: sanitizeDevboxShellComponent(name) }),
    sessionName: buildDevboxShellSessionName(profileId, id, name)
  }
}

export function resolveDevboxShellTarget(
  target: string,
  sessions: readonly OwnedShell[]
): OwnedCanonicalShell
export function resolveDevboxShellTarget(
  target: string,
  sessions: readonly OwnedShell[],
  includeLegacy: true,
  socketSelection?: DevboxShellSocketSelection
): OwnedShell
export function resolveDevboxShellTarget(
  target: string,
  sessions: readonly OwnedShell[],
  includeLegacy = false,
  socketSelection?: DevboxShellSocketSelection
): OwnedShell {
  // A current-session removal supplies the socket observed in TMUX. The
  // lifecycle listing remains authoritative: this only selects one of its
  // discovered socket identities and never invents a socket for the kill.
  const scoped = socketSelection === undefined
    ? sessions
    : sessions.filter((session) => session.socketName === socketSelection.socketName)
  const canonical = canonicalOwnedSessions(scoped)
  const numericTarget = DEVBOX_SHELL_SESSION_ID_PATTERN.test(target) ? Number(target) : undefined
  // An exact tmux session name wins over a friendly-name match: it is the only
  // unique handle when several sessions share a numeric id.
  const canonicalMatch = numericTarget === undefined
    ? canonical.find((session) => session.session.sessionName === target)
      ?? canonical.find((session) => session.session.name === safeSanitize(target))
    : canonical.find((session) => session.session.id === numericTarget)
  if (canonicalMatch) {return canonicalMatch}

  if (includeLegacy) {
    const legacy = scoped.filter((session): session is OwnedLegacyShell => !session.canonical)
    const sanitized = safeSanitize(target)
    const legacyMatch = legacy.find((session) =>
      session.session.sessionName === target || session.session.name === sanitized
    )
    if (legacyMatch) {return legacyMatch}
  }

  const existing = canonical.length === 0
    ? 'none'
    : canonical.map((session) => `${session.session.id}${session.session.name === undefined ? '' : ` (${session.session.name})`}`).join(', ')
  throw new Error(`No Devbox shell session matches '${target}'. Existing sessions: ${existing}`)
}

function canonicalOwnedSessions(sessions: readonly OwnedShell[]): OwnedCanonicalShell[] {
  const seen = new Set<string>()
  return sessions.filter((session): session is OwnedCanonicalShell => {
    if (!session.canonical || seen.has(session.session.sessionName)) {return false}
    seen.add(session.session.sessionName)
    return true
  })
}

type ParsedLegacyShell = DevboxLegacyShellSessionIdentity & {
  attached: boolean
}

function parseLegacySessionLine(
  profileId: string,
  line: string
): ParsedLegacyShell | undefined {
  const trimmed = line.trimEnd()
  if (trimmed.length === 0) {return undefined}
  const fields = trimmed.split('\t')
  // The attachment field is required for cleanup safety. A malformed or
  // truncated row is not an inventory candidate and cannot be classified as
  // detached.
  if (fields.length < 3) {return undefined}
  const identity = parseDevboxLegacyShellSessionName(profileId, fields[0] ?? '')
  if (identity === undefined) {return undefined}
  return { ...identity, attached: fields[2] !== '0' }
}

function privateSocket(profileId: string): string {
  return devboxShellSocketName(profileId)
}

function safeSanitize(value: string): string | undefined {
  try {
    return sanitizeDevboxShellComponent(value)
  } catch {
    return undefined
  }
}
