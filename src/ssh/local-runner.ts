import { spawn, type ChildProcess } from 'node:child_process'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'

const DEFAULT_LOCAL_TIMEOUT_MS = 30_000

type LocalRunnerOptions = {
  shell?: string
  env?: NodeJS.ProcessEnv
}

type ProcessError = Error & {
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stderr?: string
  timedOut?: boolean
}

export function createLocalRunner(options: LocalRunnerOptions = {}): DevboxSshRunner {
  const shell = options.shell ?? 'bash'
  assertNoNul(shell, 'local shell')
  return {
    command: (command, timeoutMs) => {
      assertNoNul(command, 'local command')
      return runLocalProcess(shell, ['-c', command], undefined, timeoutMs, options.env)
    },
    script: (script, timeoutMs) => {
      assertNoNul(script, 'local script')
      return runLocalProcess(shell, ['-s'], script, timeoutMs, options.env)
    }
  }
}

export function runLocalInteractive(
  remoteCommand: string,
  options: LocalRunnerOptions = {}
): Promise<number> {
  const shell = options.shell ?? 'bash'
  assertNoNul(shell, 'local shell')
  assertNoNul(remoteCommand, 'local command')
  const child = spawn(shell, ['-c', remoteCommand], {
    env: options.env,
    stdio: 'inherit',
    windowsHide: true
  })
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

function runLocalProcess(
  shell: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number | undefined,
  env: NodeJS.ProcessEnv | undefined
): Promise<string> {
  const timeout = normalizeTimeout(timeoutMs)
  assertNoNul(stdin, 'local script')
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      const error = createProcessError('Devbox local operation timed out', null, null, stderr)
      error.timedOut = true
      error.message = `Devbox local operation timed out after ${timeout}ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`
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
      settle(createProcessError('Devbox local stream failed', null, null, stderr, error))
    }
    const onProcessError = (error: Error): void => {
      settle(createProcessError('Devbox local process failed', null, null, stderr, error))
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        settle(null)
        return
      }
      settle(createProcessError('Devbox local operation failed', code, signal, stderr))
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
  const error = new Error(`${prefix}${status}${detail ? `: ${detail}` : ''}`, { cause }) as ProcessError
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

function assertNoNul(value: string | undefined, label: string): void {
  if (value?.includes('\0')) {
    throw new Error(`${label} must not contain NUL`)
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
    return DEFAULT_LOCAL_TIMEOUT_MS
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Local timeout must be a finite positive number')
  }
  return Math.max(1, Math.floor(timeoutMs))
}
