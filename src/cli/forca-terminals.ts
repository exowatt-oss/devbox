import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { findOnPath } from './path-command'

const FORCA_COMMAND_TIMEOUT_MS = 15_000
const SAFE_POSIX_TOKEN = /^[A-Za-z0-9_./:=@%+-]+$/u

type ForcaCliLookupOptions = {
  exists?: (path: string) => boolean
}

export type ForcaCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ForcaCommandRunner = (
  binary: string,
  argv: readonly string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<ForcaCommandResult>

export async function runForcaCommand(
  binary: string,
  argv: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<ForcaCommandResult> {
  return await new Promise((resolve) => {
    const finish = (error: unknown, stdout: unknown = '', stderr: unknown = ''): void => {
      const output = String(stderr)
      if (!error) {
        resolve({ stdout: String(stdout), stderr: output, exitCode: 0 })
        return
      }
      const failure = error as NodeJS.ErrnoException
      const exitCode = typeof failure.code === 'number'
        ? failure.code
        : failure.code === 'ENOENT' ? 127 : 1
      const message = failure.message ?? String(error)
      const errorText = failure.code === 'ENOENT' && output.length > 0
        ? `${output}\n${message}`
        : output.length > 0 ? output : message
      resolve({ stdout: String(stdout), stderr: errorText, exitCode })
    }

    try {
      execFile(
        binary,
        [...argv],
        {
          cwd: options.cwd,
          encoding: 'utf8',
          timeout: options.timeoutMs ?? FORCA_COMMAND_TIMEOUT_MS
        },
        (error, stdout, stderr) => { finish(error, stdout, stderr) }
      )
    } catch (error) {
      finish(error)
    }
  })
}

export function findForcaCli(
  env: NodeJS.ProcessEnv = process.env,
  options: ForcaCliLookupOptions = {}
): string | undefined {
  const pathBinary = findOnPath('forca', env.PATH)
  if (pathBinary) {return pathBinary}
  const fallback = '/opt/homebrew/bin/forca'
  return (options.exists ?? existsSync)(fallback) ? fallback : undefined
}

export type ForcaRuntimeProbe = { ok: true } | { ok: false; reason: string }

export async function probeForcaRuntime(
  run: ForcaCommandRunner,
  binary: string
): Promise<ForcaRuntimeProbe> {
  const result = await run(binary, ['status', '--json'])
  if (result.exitCode !== 0) {return { ok: false, reason: `exit code ${result.exitCode}` }}
  const parsed = parseJson(result.stdout)
  if (!parsed.ok) {return { ok: false, reason: 'non-JSON output' }}
  const envelope = asRecord(parsed.value)
  const payload = asRecord(envelope?.result)
  const app = asRecord(payload?.app)
  const runtime = asRecord(payload?.runtime)
  if (runtime?.reachable !== true) {
    return app?.running === true
      ? { ok: false, reason: 'runtime unreachable' }
      : { ok: false, reason: 'app not running' }
  }
  if (envelope?.ok !== true) {return { ok: false, reason: 'Forca returned ok:false' }}
  return { ok: true }
}

export async function resolveForcaWorktreeSelector(
  run: ForcaCommandRunner,
  binary: string,
  cwd: string,
  override?: string
): Promise<string> {
  if (override !== undefined) {return override}
  try {
    const result = await run(binary, ['worktree', 'current', '--json'], { cwd })
    if (result.exitCode === 0) {
      const parsed = parseJson(result.stdout)
      if (parsed.ok && asRecord(parsed.value)?.ok === true) {return `path:${cwd}`}
    }
  } catch {
    // A missing or unavailable current-worktree lookup falls back to Forca's active worktree.
  }
  return 'active'
}

export type ForcaTerminalCreateResult =
  | { ok: true; handle?: string; tabId?: string; raw: unknown }
  | { ok: false; reason: string }

export async function createForcaTerminal(
  run: ForcaCommandRunner,
  binary: string,
  input: { worktreeSelector: string; command: string; title?: string; cwd?: string }
): Promise<ForcaTerminalCreateResult> {
  const argv = ['terminal', 'create', '--worktree', input.worktreeSelector, '--command', input.command]
  if (input.title !== undefined) {argv.push('--title', input.title)}
  argv.push('--json')
  const result = await run(binary, argv, input.cwd === undefined ? undefined : { cwd: input.cwd })
  if (result.exitCode !== 0) {return { ok: false, reason: `exit code ${result.exitCode}` }}
  const parsed = parseJson(result.stdout)
  if (!parsed.ok) {return { ok: false, reason: 'non-JSON output' }}
  const envelope = asRecord(parsed.value)
  if (envelope?.ok !== true) {return { ok: false, reason: extractFailureReason(envelope) }}
  const payload = envelope.result
  return {
    ok: true,
    ...(findNestedString(payload, 'handle') === undefined ? {} : { handle: findNestedString(payload, 'handle') }),
    ...(findNestedString(payload, 'tabId') === undefined ? {} : { tabId: findNestedString(payload, 'tabId') }),
    raw: parsed.value
  }
}

/** A Forca terminal already attached to a devbox session (Forca builds that publish `devbox`). */
export type ForcaDevboxTerminal = { profileId: string; sessionName: string; handle?: string }

/**
 * Devbox sessions Forca already has a terminal for, from `terminal list --json`'s per-terminal
 * `devbox` field. Older Forca builds have no such field, and any failure reads as "none", so
 * this never blocks or changes a reconnect against them.
 */
export async function listForcaDevboxTerminals(
  run: ForcaCommandRunner,
  binary: string,
  cwd?: string
): Promise<ForcaDevboxTerminal[]> {
  try {
    const result = await run(binary, ['terminal', 'list', '--json'], cwd === undefined ? undefined : { cwd })
    if (result.exitCode !== 0) {return []}
    const parsed = parseJson(result.stdout)
    const envelope = parsed.ok ? asRecord(parsed.value) : undefined
    const terminals = asRecord(envelope?.result)?.terminals
    if (envelope?.ok !== true || !Array.isArray(terminals)) {return []}
    return terminals.flatMap((value) => {
      const terminal = asRecord(value)
      const devbox = asRecord(terminal?.devbox)
      // The documented shape is flat; tolerate a published state object `{identity: {...}}` too.
      const identity = typeof devbox?.sessionName === 'string' ? devbox : asRecord(devbox?.identity)
      const profileId = identity?.profileId
      const sessionName = identity?.sessionName
      if (typeof profileId !== 'string' || typeof sessionName !== 'string') {return []}
      const handle = terminal?.handle
      return [{ profileId, sessionName, ...(typeof handle === 'string' ? { handle } : {}) }]
    })
  } catch {
    return []
  }
}

export function quoteForPosixShell(argv: readonly string[]): string {
  return argv.map((token) => {
    if (token.length > 0 && SAFE_POSIX_TOKEN.test(token)) {return token}
    return `'${token.replaceAll("'", "'\\''")}'`
  }).join(' ')
}

function detectSea(): boolean {
  try {
    if (typeof require !== 'function') {return false}
    const sea = require('node:sea') as { isSea?: () => boolean }
    return sea.isSea?.() === true
  } catch {
    return false
  }
}

export function resolveDevboxSelfCommand(
  _argv0: readonly string[] | string = process.argv,
  execPath = process.execPath,
  isSea: (() => boolean) | boolean = detectSea
): string {
  const sea = typeof isSea === 'function' ? isSea() : isSea
  return sea ? execPath : 'devbox'
}

/**
 * Attach by the exact tmux session name: numeric ids are not unique (several
 * sessions on one profile can share an id), session names are.
 */
export function buildDevboxShellAttachCommandLine(
  devboxCommand: string,
  profileId: string,
  sessionName: string
): string {
  return quoteForPosixShell([devboxCommand, 'shell', sessionName, '--profile', profileId])
}

type ParsedJson = { ok: true; value: unknown } | { ok: false }

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {return undefined}
  return value as Record<string, unknown>
}

function findNestedString(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, key)
      if (found !== undefined) {return found}
    }
    return undefined
  }
  const record = asRecord(value)
  if (!record) {return undefined}
  if (typeof record[key] === 'string') {return record[key]}
  for (const child of Object.values(record)) {
    const found = findNestedString(child, key)
    if (found !== undefined) {return found}
  }
  return undefined
}

function extractFailureReason(envelope: Record<string, unknown> | undefined): string {
  const reason = findNestedString(envelope, 'reason')
    ?? findNestedString(envelope, 'error')
    ?? findNestedString(envelope, 'message')
  return reason ?? 'Forca returned ok:false'
}
