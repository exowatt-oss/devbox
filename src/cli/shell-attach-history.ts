import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import type { DevboxShellSession } from './shell-sessions'
import { selectMostRecentDevboxShellSession } from './shell-sessions'

export const DEVBOX_SHELL_ATTACH_HISTORY_FILE = 'shell-attach-history.json'
const DEVBOX_SHELL_ATTACH_HISTORY_VERSION = 1
const DEFAULT_MAX_ENTRIES = 200
const ORCA_TERMINAL_HANDLE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u

type DevboxShellAttachHistoryFile = {
  version: typeof DEVBOX_SHELL_ATTACH_HISTORY_VERSION
  entries: DevboxShellAttachRecord[]
}

type UnknownRecord = Record<string, unknown>

type DevboxTtySpawnResult = {
  stdout?: string | Buffer
  status?: number | null
  signal?: NodeJS.Signals | null
  error?: Error | null
}

export type DevboxTtySpawn = (
  command: string,
  options: { stdio: ['inherit', 'pipe', 'ignore'] }
) => DevboxTtySpawnResult

export type DevboxShellAttachRecord = {
  profileId: string
  sessionName: string
  id: number
  name?: string
  terminalKey: string
  attachedAt: number
}

export type DevboxShellAttachHistory = {
  readonly terminalKey: string
  record(entry: { profileId: string; sessionName: string; id: number; name?: string }): Promise<void>
  lastForTerminal(profileId: string): Promise<DevboxShellAttachRecord | undefined>
  lastForProfile(profileId: string): Promise<DevboxShellAttachRecord | undefined>
}

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value)

function isAttachRecord(value: unknown): value is DevboxShellAttachRecord {
  if (!isRecord(value)) {return false}
  return typeof value.profileId === 'string' && value.profileId.length > 0
    && typeof value.sessionName === 'string' && value.sessionName.length > 0
    && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0
    && (value.name === undefined || typeof value.name === 'string')
    && typeof value.terminalKey === 'string' && value.terminalKey.length > 0
    && typeof value.attachedAt === 'number' && Number.isFinite(value.attachedAt)
}

function parseHistory(value: unknown): DevboxShellAttachRecord[] {
  if (!isRecord(value) || value.version !== DEVBOX_SHELL_ATTACH_HISTORY_VERSION || !Array.isArray(value.entries)) {
    return []
  }
  return value.entries.every(isAttachRecord) ? value.entries : []
}

async function readEntries(path: string): Promise<DevboxShellAttachRecord[]> {
  try {
    return parseHistory(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return []
  }
}

async function writeEntries(path: string, entries: readonly DevboxShellAttachRecord[]): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const document: DevboxShellAttachHistoryFile = { version: DEVBOX_SHELL_ATTACH_HISTORY_VERSION, entries: [...entries] }
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // Preserve the write failure; a stale temp file is harmless on the next write.
    }
    throw error
  }
}

export function resolveDevboxTerminalKey(env: NodeJS.ProcessEnv, ttyPath: () => string | undefined): string {
  const handle = env.ORCA_TERMINAL_HANDLE
  if (typeof handle === 'string' && ORCA_TERMINAL_HANDLE_PATTERN.test(handle)) {
    return `orca:${handle}`
  }
  try {
    const path = ttyPath()
    if (path !== undefined && isAbsolute(path)) {
      return `tty:${path}`
    }
  } catch {
    // A TTY probe is best effort; an unknown terminal still has useful profile history.
  }
  return 'unknown'
}

const defaultTtySpawn: DevboxTtySpawn = (command, options) => spawnSync(command, options) as DevboxTtySpawnResult

export function readDevboxTtyPath(spawn: DevboxTtySpawn = defaultTtySpawn): string | undefined {
  try {
    if (!process.stdin.isTTY) {return undefined}
    const result = spawn('tty', { stdio: ['inherit', 'pipe', 'ignore'] })
    if (result.error || result.signal || (result.status !== undefined && result.status !== null && result.status !== 0)) {
      return undefined
    }
    const output = result.stdout
    const text = Buffer.isBuffer(output) ? output.toString('utf8') : output
    const trimmed = text?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

export function createDevboxShellAttachHistory(options: {
  stateRoot: string
  env?: NodeJS.ProcessEnv
  terminalKey?: string
  now?: () => number
  maxEntries?: number
}): DevboxShellAttachHistory {
  const env = options.env ?? process.env
  const terminalKey = options.terminalKey ?? resolveDevboxTerminalKey(env, readDevboxTtyPath)
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries !== undefined && Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES
  const path = join(options.stateRoot, DEVBOX_SHELL_ATTACH_HISTORY_FILE)

  return {
    terminalKey,
    async record(entry) {
      const entries = await readEntries(path)
      const withoutDuplicate = entries.filter((existing) => existing.terminalKey !== terminalKey
        || existing.profileId !== entry.profileId
        || existing.sessionName !== entry.sessionName)
      withoutDuplicate.push({ ...entry, terminalKey, attachedAt: now() })
      await writeEntries(path, withoutDuplicate.slice(-maxEntries))
    },
    async lastForTerminal(profileId) {
      const entries = await readEntries(path)
      return entries.toReversed().find((entry) => entry.terminalKey === terminalKey && entry.profileId === profileId)
    },
    async lastForProfile(profileId) {
      const entries = await readEntries(path)
      return entries.toReversed().find((entry) => entry.profileId === profileId)
    }
  }
}

export async function resolveDevboxResumeTarget(
  history: DevboxShellAttachHistory,
  profileId: string,
  sessions: readonly DevboxShellSession[]
): Promise<{ session: DevboxShellSession; source: 'terminal' | 'profile' | 'most-recent' } | undefined> {
  const find = (record: DevboxShellAttachRecord | undefined): DevboxShellSession | undefined => record === undefined
    ? undefined
    : sessions.find((session) => session.sessionName === record.sessionName)
  const terminalSession = find(await history.lastForTerminal(profileId))
  if (terminalSession) {return { session: terminalSession, source: 'terminal' }}
  const profileSession = find(await history.lastForProfile(profileId))
  if (profileSession) {return { session: profileSession, source: 'profile' }}
  const mostRecent = selectMostRecentDevboxShellSession(sessions)
  return mostRecent === undefined ? undefined : { session: mostRecent, source: 'most-recent' }
}
