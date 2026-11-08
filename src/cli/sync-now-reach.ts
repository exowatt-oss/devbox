import { spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import type { ServiceExec } from './mutagen-service'
import { runDevboxShellProbe, type DevboxShellProbeBudget } from './shell-probe-run'
import type { SyncNowTarget } from './sync-now-plan'

/**
 * Reachability gate for `db sync`. Mutagen's own ssh goes through the same
 * ProxyCommand, so a session must never be resumed until this passed: resuming
 * a stopped host's sessions could wake it. An optional power provider lets
 * operators check host state without triggering the SSH proxy.
 */
// Why: a loaded Mac (load average 100+) can take several seconds just to spawn ssh, so a tight
// budget faked outages of healthy machines; a dead host still fails at the connect timeout.
export const SYNC_DIRECT_BUDGET: DevboxShellProbeBudget = { connectTimeoutMs: 8_000, capMs: 10_000, wakeCapMs: 10_000 }
/** A reachable host behind a ProxyCommand, without a power transition. */
export const SYNC_PROXIED_BUDGET: DevboxShellProbeBudget = { connectTimeoutMs: 20_000, capMs: 20_000, wakeCapMs: 20_000 }
/** `--wake`: the proxy starts a stopped box and the probe waits for it to boot. */
export const SYNC_WAKE_BUDGET: DevboxShellProbeBudget = { connectTimeoutMs: 240_000, capMs: 240_000, wakeCapMs: 240_000 }

export type SyncReachResult = { ok: true } | { ok: false; reason: 'unreachable' | 'stopped'; detail: string }

export type SyncReachOptions = {
  wake: boolean
  signal: AbortSignal
  /** The box is being started (or the proxy reported a power transition). */
  onWaking: (detail: string) => void
}

export type SyncReach = (target: SyncNowTarget, options: SyncReachOptions) => Promise<SyncReachResult>

export type SyncProbe = (target: SyncNowTarget, budget: DevboxShellProbeBudget, onWaking: (detail: string) => void, signal: AbortSignal) => Promise<void>

export type SyncReachDeps = {
  exec: ServiceExec
  home: string
  /** Opt-in: basename of a ProxyCommand executable with `status` reporting `state: running|stopped`. */
  powerCli?: string
  probe?: SyncProbe
}

export function createSyncReach(deps: SyncReachDeps): SyncReach {
  const probe = deps.probe ?? probeWithSsh
  return async (target, options) => {
    const proxyCommand = target.proxyCommand ?? (target.local ? undefined : await sshConfigProxyCommand(deps.exec, target))
    const powerProvider = proxyCommand === undefined || deps.powerCli === undefined
      ? undefined : proxyPowerCliOf(proxyCommand, deps.home, deps.powerCli)
    let budget = proxyCommand === undefined ? SYNC_DIRECT_BUDGET : SYNC_PROXIED_BUDGET
    if (powerProvider !== undefined) {
      const status = await proxyPowerState(deps.exec, powerProvider)
      if (status.state !== 'running') {
        if (!options.wake) {
          return status.state === undefined
            ? { ok: false, reason: 'unreachable', detail: `${status.detail}; not probing so a stopped host is not woken (db sync --wake)` }
            : { ok: false, reason: 'stopped', detail: `${status.state} (db sync --wake allows probing)` }
        }
        options.onWaking(status.state === undefined ? 'probing the host' : `probing the ${status.state} host`)
        budget = SYNC_WAKE_BUDGET
      }
    }
    try {
      await probe(target, budget, options.onWaking, options.signal)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: oneLine(error) }
    }
  }
}

/** Match only a configured power provider to avoid assuming arbitrary SSH proxies have `status`. */
export function proxyPowerCliOf(proxyCommand: string, home: string, provider: string): string | undefined {
  const [first, second] = proxyCommand.trim().split(/\s+/u)
  if (first === undefined || second !== 'proxy') {return undefined}
  const binary = first.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/u, home)
  return basename(binary) === provider ? binary : undefined
}

/** A configured provider's `status` output; this probe is read-only. */
export async function proxyPowerState(exec: ServiceExec, binary: string): Promise<{ state?: string; detail: string }> {
  const result = await exec(binary, ['status'], { timeoutMs: 15_000 })
  const state = /^state:\s*(\S+)/mu.exec(result.stdout)?.[1]
  if (result.exitCode === 0 && state !== undefined) {return { state, detail: `state: ${state}` }}
  const reason = oneLine(result.stderr) || oneLine(result.stdout) || `exit ${result.exitCode}`
  return { detail: `power provider status failed (${reason})` }
}

/**
 * ProxyCommand that ~/.ssh/config applies to this endpoint (`ssh -G` reads config only,
 * no network). Mutagen's ssh and the probe both honour it, so it must gate waking too.
 */
async function sshConfigProxyCommand(exec: ServiceExec, target: SyncNowTarget): Promise<string | undefined> {
  const { username, host, port } = target.endpoint
  const result = await exec('ssh', ['-G', '-p', String(port), `${username}@${host}`], { timeoutMs: 15_000 })
  if (result.exitCode !== 0) {return undefined}
  const value = /^proxycommand\s+(.+)$/imu.exec(result.stdout)?.[1]?.trim()
  return value === undefined || value.toLowerCase() === 'none' ? undefined : value
}

const probeWithSsh: SyncProbe = async (target, budget, onWaking, signal) => {
  const children = new Set<ChildProcess>()
  const onAbort = (): void => { for (const child of children) {child.kill('SIGKILL')} }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await runDevboxShellProbe({ endpoint: target.endpoint, local: target.local }, 'true', budget, { onWaking }, (command, args) => {
      const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      children.add(child)
      if (signal.aborted) {child.kill('SIGKILL')}
      return child
    })
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? '')
  return message.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)?.replace(/\s+/gu, ' ') ?? ''
}
