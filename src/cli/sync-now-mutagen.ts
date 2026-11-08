import { spawn, type ChildProcess } from 'node:child_process'
import { DEVBOX_SYNC_BACKEND_LABEL } from '../sync/devbox-sync-backend'
import { parseSyncSessions, type SyncSessionSnapshot } from './sync-now-session'

/** A Mutagen CLI call failed; `timedOut` when it was killed at its cap rather than erroring. */
export class SyncMutagenError extends Error {
  /** `output` = the call's whole stderr (the message is only its last line). */
  constructor(message: string, readonly timedOut: boolean, readonly output?: string) {
    super(message)
    this.name = 'SyncMutagenError'
  }
}

/**
 * What Mutagen and ssh print when an endpoint cannot be reached or the link drops while
 * connecting (`unable to connect to beta: ...`, ssh's `Connection to UNKNOWN port 65535
 * timed out` behind a ProxyCommand, `exit status 255`, handshake/host-key trouble).
 */
const CONNECTION_ERROR = /unable to connect|unable to dial|timed out|connection (?:refused|reset|closed|lost)|closed by remote host|connection to \S+ port \d+|no route to host|network is (?:unreachable|down)|host is down|could not resolve hostname|exit status 255|host key verification failed|kex_exchange_identification|handshake|broken pipe|ssh: connect to host/iu

/** True when a Mutagen call failed because an endpoint could not be (re)connected, not because the session is broken. */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof SyncMutagenError) {return CONNECTION_ERROR.test(`${error.message}\n${error.output ?? ''}`)}
  return error instanceof Error && CONNECTION_ERROR.test(error.message)
}

export type SyncFlushResult = { ok: true } | { ok: false; message: string }

/** One running `mutagen sync flush <ids>` child. */
export type SyncFlushHandle = {
  done: Promise<SyncFlushResult>
  kill(): void
}

/** The Mutagen operations `db sync` needs, always against the devbox-private daemon. */
export type SyncNowMutagen = {
  list(): Promise<SyncSessionSnapshot[]>
  resume(ids: readonly string[]): Promise<void>
  pause(ids: readonly string[]): Promise<void>
  /**
   * Never capped here: the engine owns stall/timeout decisions and kills the children.
   * `onFlushed` hears each session whose own flush completed.
   */
  flush(ids: readonly string[], onFlushed?: (id: string) => void): SyncFlushHandle
  /** Fire-and-forget `sync pause` that outlives this process (used on a hard exit). */
  pauseDetached?(ids: readonly string[]): void
}

export type SyncSpawn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess

export type SyncNowMutagenOptions = {
  binaryPath: string
  dataDirectory: string
  env: NodeJS.ProcessEnv
  /** Cap for each session's resume (default 20 s). */
  timeoutMs?: number
  /** Cap for each session's pause (default 60 s): Mutagen pauses only once a running scan ends. */
  pauseTimeoutMs?: number
  /** Cap for `sync list` (default 15 s). */
  listTimeoutMs?: number
  spawn?: SyncSpawn
}

const defaultSpawn: SyncSpawn = (command, args, options) =>
  spawn(command, [...args], { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

/** Environment for every Mutagen CLI call: the devbox-private data directory, never autostart. */
export function syncMutagenEnv(env: NodeJS.ProcessEnv, dataDirectory: string): NodeJS.ProcessEnv {
  return { ...env, MUTAGEN_DATA_DIRECTORY: dataDirectory, MUTAGEN_DISABLE_AUTOSTART: '1' }
}

export function createSyncNowMutagen(options: SyncNowMutagenOptions): SyncNowMutagen {
  const env = syncMutagenEnv(options.env, options.dataDirectory)
  const spawnImpl = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? 20_000
  const run = (args: readonly string[], cap: number): Promise<string> => runCapped(spawnImpl, options.binaryPath, args, env, cap)
  // One CLI call per session, all at once: Mutagen works through the sessions of a
  // single `sync resume|pause|flush a b c` call one after another (a flush forces one
  // full cycle per session in turn), which made a machine with two big roots take twice
  // as long and let one slow pause push the rest past the cap.
  const each = async (verb: 'resume' | 'pause', ids: readonly string[], cap: number): Promise<void> => {
    const results = await Promise.allSettled(ids.map((id) => run(['sync', verb, id], cap)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : [])
    // A real Mutagen error outranks a timeout (a timed-out resume is still connecting).
    if (errors.length > 0) {throw errors.find((error) => !(error instanceof SyncMutagenError && error.timedOut)) ?? errors[0]}
  }
  return {
    list: async () => parseSyncSessions(await run(['sync', 'list', `--label-selector=${DEVBOX_SYNC_BACKEND_LABEL}=mutagen`, '--template', '{{json .}}'], options.listTimeoutMs ?? 15_000)),
    resume: (ids) => each('resume', ids, timeoutMs),
    pause: (ids) => each('pause', ids, options.pauseTimeoutMs ?? 60_000),
    flush: (ids, onFlushed) => flushAll(ids, (id) => startFlush(spawnImpl, options.binaryPath, [id], env), onFlushed),
    pauseDetached: (ids) => {
      if (ids.length === 0) {return}
      const child = spawn(options.binaryPath, ['sync', 'pause', ...ids], { env, stdio: 'ignore', detached: true, windowsHide: true })
      child.on('error', () => undefined)
      child.unref()
    }
  }
}

/** All sessions' flushes as one handle: ok once every one succeeded; the first failure stops the rest. */
function flushAll(ids: readonly string[], start: (id: string) => SyncFlushHandle, onFlushed?: (id: string) => void): SyncFlushHandle {
  const handles = ids.map((id) => ({ id, handle: start(id) }))
  let killed = false
  const kill = (): void => {
    if (killed) {return}
    killed = true
    for (const { handle } of handles) {handle.kill()}
  }
  const done = new Promise<SyncFlushResult>((resolve) => {
    let pending = handles.length
    if (pending === 0) {resolve({ ok: true })}
    for (const { id, handle } of handles) {
      void handle.done.then((result) => {
        if (!result.ok) {
          kill()
          resolve(result)
          return
        }
        if (!killed) {onFlushed?.(id)}
        pending -= 1
        if (pending === 0) {resolve({ ok: true })}
      })
    }
  })
  return { done, kill }
}

function runCapped(spawnImpl: SyncSpawn, binary: string, args: readonly string[], env: NodeJS.ProcessEnv, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnImpl(binary, args, { env })
    } catch (error) {
      reject(new SyncMutagenError(`could not start mutagen: ${errorText(error)}`, false))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      settle(new SyncMutagenError(`mutagen ${args.slice(0, 2).join(' ')} gave no answer within ${cap < 1_000 ? `${cap} ms` : `${Math.round(cap / 1000)} s`}`, true))
      terminate(child)
    }, cap)
    function settle(error: Error | null): void {
      if (settled) {return}
      settled = true
      clearTimeout(timer)
      if (error) {reject(error)} else {resolve(stdout)}
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = keepTail(stderr + chunk.toString('utf8')) })
    child.once('error', (error) => settle(new SyncMutagenError(`could not start mutagen: ${error.message}`, false)))
    child.once('close', (code) => settle(code === 0 ? null : new SyncMutagenError(mutagenMessage(stderr) || `mutagen exited with status ${code ?? 'signal'}`, false, stderr.replace(ANSI_ESCAPE, ''))))
  })
}

function startFlush(spawnImpl: SyncSpawn, binary: string, ids: readonly string[], env: NodeJS.ProcessEnv): SyncFlushHandle {
  let child: ChildProcess | undefined
  const done = new Promise<SyncFlushResult>((resolve) => {
    try {
      child = spawnImpl(binary, ['sync', 'flush', ...ids], { env })
    } catch (error) {
      resolve({ ok: false, message: `could not start mutagen: ${errorText(error)}` })
      return
    }
    let stderr = ''
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (chunk: Buffer) => { stderr = keepTail(stderr + chunk.toString('utf8')) })
    child.once('error', (error) => resolve({ ok: false, message: `could not start mutagen: ${error.message}` }))
    child.once('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, message: mutagenMessage(stderr) || `mutagen sync flush exited with status ${code ?? 'signal'}` }))
  })
  return { done, kill: () => { if (child) {terminate(child)} } }
}

/** SIGTERM (Mutagen cancels the request cleanly), SIGKILL if it lingers. */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {return}
  try { child.kill('SIGTERM') } catch { return }
  const force = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 2_000)
  force.unref()
  child.once('close', () => clearTimeout(force))
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'gu')

/** Mutagen's last error line without the `Error: ` prefix or terminal escapes. */
export function mutagenMessage(stderr: string): string {
  const lines = stderr
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n|\r/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = (lines.at(-1) ?? '').replace(/^Error:\s*/u, '')
  // Mutagen wraps ssh's output in `(...)`; the last line alone keeps only the closing paren.
  return last.endsWith(')') && count(last, '(') < count(last, ')') ? last.slice(0, -1).trimEnd() : last
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

function keepTail(text: string): string {
  return text.length > 8_192 ? text.slice(-8_192) : text
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
