import { spawn, type ChildProcess } from 'node:child_process'
import type { SshEndpoint } from '../shared/ssh-runner-types'
import { createLocalRunner } from '../ssh/local-runner'
import { hasProxyCommandOption } from '../ssh/ssh-proxy'
import { buildSystemSshArgv } from '../ssh/system-ssh-runner'

/**
 * Listing budgets. `shell ls` is read-only and interactive, so a dead host must
 * cost seconds, not the 10-30 s mutating commands keep. A ProxyCommand endpoint
 * (the AWS `devbox proxy` helper) gets a longer cap because the proxy itself
 * makes an API round trip, and an extended one once it reports that it is
 * waking a stopped box.
 */
export type DevboxShellProbeBudget = {
  connectTimeoutMs: number
  capMs: number
  wakeCapMs: number
}

export const DEVBOX_SHELL_LIST_DIRECT_BUDGET: DevboxShellProbeBudget = { connectTimeoutMs: 3_000, capMs: 5_000, wakeCapMs: 5_000 }
export const DEVBOX_SHELL_LIST_PROXIED_BUDGET: DevboxShellProbeBudget = { connectTimeoutMs: 180_000, capMs: 10_000, wakeCapMs: 180_000 }

export function devboxShellListBudget(endpoint: SshEndpoint): DevboxShellProbeBudget {
  return hasProxyCommandOption(endpoint.extraOptions) ? DEVBOX_SHELL_LIST_PROXIED_BUDGET : DEVBOX_SHELL_LIST_DIRECT_BUDGET
}

export type DevboxShellProbeTarget = {
  endpoint: SshEndpoint
  local: boolean
}

export type DevboxShellProbeHooks = {
  /** The proxy reported a power transition (stopped box being started, booting, ...). */
  onWaking?: (message: string) => void
}

export type DevboxShellProbeSpawn = (command: string, args: readonly string[]) => ChildProcess

export class DevboxShellProbeError extends Error {
  constructor(message: string, readonly reason: 'connect-timeout' | 'timeout' | 'unreachable' | 'failed') {
    super(message)
    this.name = 'DevboxShellProbeError'
  }
}

const WAKE_LINE = /^devbox:\s+(.+?)(?:\.\.\.)?\s*$/u

export function runDevboxShellProbe(
  target: DevboxShellProbeTarget,
  remoteCommand: string,
  budget: DevboxShellProbeBudget = devboxShellListBudget(target.endpoint),
  hooks: DevboxShellProbeHooks = {},
  spawnImpl: DevboxShellProbeSpawn = (command, args) => spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
): Promise<string> {
  if (target.local) {
    return createLocalRunner().command(remoteCommand, budget.capMs)
  }
  const args = buildSystemSshArgv(target.endpoint, remoteCommand, budget.connectTimeoutMs)
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args)
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let waking = false
    let settled = false
    let timer = setTimeout(onDeadline, budget.capMs)
    function finish(error: Error | null): void {
      if (settled) {return}
      settled = true
      clearTimeout(timer)
      if (error) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        reject(error)
      } else {
        resolve(stdout)
      }
    }
    function onDeadline(): void {
      const seconds = formatSeconds(Date.now() - started)
      finish(new DevboxShellProbeError(waking ? `box still waking after ${seconds}` : `no answer within ${seconds}`, 'timeout'))
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      for (const line of text.split(/\r?\n/u)) {
        const match = WAKE_LINE.exec(line.trim())
        if (match === null || stdout.length > 0) {continue}
        if (!waking) {
          waking = true
          clearTimeout(timer)
          timer = setTimeout(onDeadline, Math.max(0, started + budget.wakeCapMs - Date.now()))
        }
        hooks.onWaking?.(match[1]!)
      }
    })
    child.once('error', (error) => finish(new DevboxShellProbeError(`ssh failed to start: ${error.message}`, 'failed')))
    child.once('close', (code) => {
      if (code === 0) {
        finish(null)
        return
      }
      finish(classifyFailure(code, stderr, budget))
    })
  })
}

function classifyFailure(code: number | null, stderr: string, budget: DevboxShellProbeBudget): DevboxShellProbeError {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('Warning: Permanently added'))
  const last = lines.at(-1) ?? ''
  if (code === 255) {
    if (/timed out/iu.test(stderr)) {
      return new DevboxShellProbeError(`connect timed out after ${formatSeconds(budget.connectTimeoutMs)}`, 'connect-timeout')
    }
    return new DevboxShellProbeError(last.replace(/^ssh:\s*/u, '') || 'ssh connection failed', 'unreachable')
  }
  return new DevboxShellProbeError(`remote probe failed (exit ${code ?? 'signal'})${last ? `: ${last}` : ''}`, 'failed')
}

export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
}
