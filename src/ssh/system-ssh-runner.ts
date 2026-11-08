import { spawn, type ChildProcess } from 'node:child_process'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'

export const DEFAULT_SSH_TIMEOUT_MS = 30_000

export function buildSystemSshArgv(
  endpoint: SshEndpoint,
  remoteCommand: string,
  timeoutMs = DEFAULT_SSH_TIMEOUT_MS,
  options: { pty?: boolean; remoteForwards?: readonly string[] } = {}
): string[] {
  const timeout = normalizeTimeout(timeoutMs)
  validateEndpoint(endpoint)
  assertNoNul(remoteCommand, 'SSH command')
  const args = [
    ...(options.pty ? ['-t'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    ...(options.remoteForwards && options.remoteForwards.length > 0
      ? ['-o', 'ExitOnForwardFailure=no']
      : ['-o', 'ClearAllForwardings=yes']),
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(timeout / 1000))}`
  ]
  if (endpoint.knownHostsFile !== undefined) {
    args.push('-o', `UserKnownHostsFile=${endpoint.knownHostsFile}`)
  }
  for (const option of endpoint.extraOptions ?? []) {
    assertNoNul(option, 'SSH option')
    args.push('-o', option)
  }
  for (const forward of options.remoteForwards ?? []) {
    assertValidRemoteForward(forward)
    args.push('-R', forward)
  }
  args.push('-p', String(endpoint.port), '--', `${endpoint.username}@${endpoint.host}`, remoteCommand)
  return args
}

export function createSystemSshRunner(
  endpoint: SshEndpoint,
  options: { sshBinary?: string } = {}
): DevboxSshRunner {
  const sshBinary = options.sshBinary ?? 'ssh'
  assertNoNul(sshBinary, 'SSH binary')
  validateEndpoint(endpoint)
  return {
    command: (command, timeoutMs) =>
      runSshProcess(sshBinary, buildSystemSshArgv(endpoint, command, timeoutMs), undefined, timeoutMs),
    script: (script, timeoutMs) =>
      runSshProcess(
        sshBinary,
        buildSystemSshArgv(endpoint, 'bash -s', timeoutMs),
        script,
        timeoutMs
      )
  }
}

export function spawnSystemSshInteractive(
  endpoint: SshEndpoint,
  remoteCommand: string,
  options: { env?: NodeJS.ProcessEnv; sshBinary?: string; remoteForwards?: readonly string[] } = {}
): ChildProcess {
  const sshBinary = options.sshBinary ?? 'ssh'
  assertNoNul(sshBinary, 'SSH binary')
  return spawn(sshBinary, buildSystemSshArgv(endpoint, remoteCommand, undefined, {
    pty: true,
    remoteForwards: options.remoteForwards
  }), {
    env: options.env,
    stdio: 'inherit',
    windowsHide: true
  })
}

export function runSystemSshInteractive(
  endpoint: SshEndpoint,
  remoteCommand: string,
  options: { env?: NodeJS.ProcessEnv; sshBinary?: string; remoteForwards?: readonly string[] } = {}
): Promise<number> {
  const child = spawnSystemSshInteractive(endpoint, remoteCommand, options)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      resolve(signal ? 128 + signalNumber(signal) : 1)
    })
  })
}

type ProcessError = Error & {
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stderr?: string
  timedOut?: boolean
}

function runSshProcess(
  sshBinary: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number | undefined
): Promise<string> {
  const timeout = normalizeTimeout(timeoutMs)
  assertNoNul(stdin, 'SSH script')
  return new Promise((resolve, reject) => {
    const child = spawn(sshBinary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      const error = createProcessError(
        'Devbox SSH operation timed out',
        null,
        null,
        stderr
      )
      error.timedOut = true
      error.message = `Devbox SSH operation timed out after ${timeout}ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`
      killChild(child)
      settle(error)
    }, timeout)

    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.stdin?.off('error', onStreamError)
      child.off('error', onProcessError)
      child.off('close', onClose)
    }
    const settle = (error: ProcessError | null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve(stdout)
      }
    }
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
    }
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8')
    }
    const onStreamError = (error: Error): void => {
      settle(createProcessError('Devbox SSH stream failed', null, null, stderr, error))
    }
    const onProcessError = (error: Error): void => {
      settle(createProcessError('Devbox SSH process failed', null, null, stderr, error))
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        settle(null)
        return
      }
      settle(createProcessError('Devbox SSH operation failed', code, signal, stderr))
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.stdin?.on('error', onStreamError)
    child.once('error', onProcessError)
    child.once('close', onClose)
    if (stdin === undefined) {
      child.stdin?.end()
    } else {
      child.stdin?.end(stdin)
    }
  })
}

function createProcessError(
  prefix: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  cause?: Error
): ProcessError {
  const status = exitCode !== null ? ` (exit ${exitCode})` : signal ? ` (signal ${signal})` : ''
  const detail = stderr.trim()
  const error = new Error(`${prefix}${status}${detail ? `: ${detail}` : ''}`, {
    cause
  }) as ProcessError
  error.exitCode = exitCode
  error.signal = signal
  error.stderr = stderr
  return error
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGKILL')
  } catch {
    // The process may have exited between the timeout and kill call.
  }
}

function validateEndpoint(endpoint: SshEndpoint): void {
  assertNoNul(endpoint.host, 'SSH host')
  assertNoNul(endpoint.username, 'SSH username')
  assertNoNul(endpoint.knownHostsFile, 'known_hosts path')
  for (const option of endpoint.extraOptions ?? []) {
    assertNoNul(option, 'SSH option')
    if (/[\r\n]/u.test(option)) {
      throw new Error('SSH option must not contain newlines')
    }
  }
}

function assertNoNul(value: string | undefined, label: string): void {
  if (value?.includes('\0')) {
    throw new Error(`${label} must not contain NUL`)
  }
}

function assertValidRemoteForward(value: string): void {
  assertNoNul(value, 'SSH remote forward')
  if (value.length === 0 || /\s/u.test(value)) {
    throw new Error('SSH remote forward must not contain whitespace or be empty')
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const signals: NodeJS.Signals[] = [
    'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE',
    'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM'
  ]
  const index = signals.indexOf(signal)
  return index >= 0 ? index + 1 : 1
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_SSH_TIMEOUT_MS
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('SSH timeout must be a finite positive number')
  }
  return Math.max(1, Math.floor(timeoutMs))
}
