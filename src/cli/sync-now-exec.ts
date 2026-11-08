import { spawn, type ChildProcess } from 'node:child_process'
import type { ServiceExec } from './mutagen-service'

/**
 * Bounded child process for `db sync` helpers (hooks, `devbox status`, `ssh -G`).
 * The child gets its own process group, so a timeout or Ctrl-C also stops its
 * grandchildren (a hook's ssh, the devbox CLI's curl), and the run settles at its
 * cap even when a grandchild still holds the output pipes: Node's `close` event
 * alone would wait for every pipe holder and could wait forever.
 */
export type BoundedRunOptions = {
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** SIGTERM → SIGKILL grace (default 2 s). */
  killGraceMs?: number
}

export type BoundedRunResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  spawnError?: string
}

/** After the child exits, how long a grandchild may keep the pipes before we stop reading. */
const PIPE_GRACE_MS = 1_000
const KEEP_BYTES = 16_384
const GROUPS = process.platform !== 'win32'

const live = new Set<ChildProcess>()
let exitHookInstalled = false

/** A hard exit (second Ctrl-C) must not orphan running hooks: kill every live group. */
function trackLive(child: ChildProcess): void {
  live.add(child)
  if (exitHookInstalled) {return}
  exitHookInstalled = true
  process.on('exit', () => { for (const running of live) {signalGroup(running, 'SIGKILL')} })
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (GROUPS && child.pid !== undefined) {
      process.kill(-child.pid, signal)
      return
    }
  } catch {
    // The group is gone (or never formed); fall back to the direct child.
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

export function runBounded(command: string, args: readonly string[], options: BoundedRunOptions): Promise<BoundedRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: GROUPS, windowsHide: true })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: error instanceof Error ? error.message : String(error) })
      return
    }
    trackLive(child)
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (ms: number, run: () => void): void => { timers.add(setTimeout(run, ms)) }
    let stdout = ''
    let stderr = ''
    let code: number | null = null
    let stopped: 'timeout' | 'abort' | undefined
    let spawnError: string | undefined
    let settled = false
    const settle = (): void => {
      if (settled) {return}
      settled = true
      for (const timer of timers) {clearTimeout(timer)}
      options.signal?.removeEventListener('abort', onAbort)
      live.delete(child)
      resolve({ code, stdout, stderr, timedOut: stopped === 'timeout', aborted: stopped === 'abort', ...(spawnError === undefined ? {} : { spawnError }) })
    }
    const stop = (why: 'timeout' | 'abort'): void => {
      if (stopped !== undefined || settled) {return}
      stopped = why
      signalGroup(child, 'SIGTERM')
      later(options.killGraceMs ?? 2_000, () => {
        signalGroup(child, 'SIGKILL')
        later(500, settle)
      })
    }
    const onAbort = (): void => stop('abort')
    later(options.timeoutMs, () => stop('timeout'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {stop('abort')}
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-KEEP_BYTES) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-KEEP_BYTES) })
    child.once('error', (error) => {
      spawnError = error.message
      settle()
    })
    child.once('exit', (exitCode) => {
      code = exitCode
      later(PIPE_GRACE_MS, settle)
    })
    child.once('close', settle)
  })
}

/** ServiceExec over runBounded: `timeoutMs` is a real cap (exit 124 when it fires). */
export const boundedServiceExec: ServiceExec = async (command, args, options) => {
  const timeoutMs = options?.timeoutMs ?? 10_000
  const result = await runBounded(command, args, { timeoutMs, ...(options?.env === undefined ? {} : { env: options.env }) })
  if (result.spawnError !== undefined) {return { exitCode: 127, stdout: '', stderr: result.spawnError }}
  if (result.timedOut) {return { exitCode: 124, stdout: result.stdout, stderr: `${command} gave no answer within ${formatMs(timeoutMs)}` }}
  return { exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr }
}

export function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`
}
