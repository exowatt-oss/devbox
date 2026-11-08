export const SSH_TRANSPORT_FAILURE_EXIT_CODE = 255

export type DevboxShellReconnectKeyStream = {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export type DevboxShellReconnectOptions = {
  attempt: () => Promise<number>
  label: string
  enabled?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: DevboxShellReconnectKeyStream
  stderr?: { isTTY?: boolean; write(chunk: string): boolean }
  initialDelayMs?: number
  maxDelayMs?: number
  healthyAttachMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onSignal?: (handler: () => void) => () => void
  /** Called as each reconnect wait starts; `attempt` is the 1-based retry about to run. */
  onReconnectWait?: (wait: { attempt: number; retryInMs: number }) => void
  /** Called once when the user abandons the reconnect wait. */
  onAbandon?: () => void
}

export type DevboxShellReconnectOutcome = {
  exitCode: number
  attempts: number
  reconnected: boolean
  abandoned: boolean
}

type ReconnectWaitOutcome = 'retry' | 'abandon'
type ReconnectStderr = { isTTY?: boolean; write(chunk: string): boolean }

export function isDevboxShellReconnectEnabled(
  env: NodeJS.ProcessEnv,
  stdin: { isTTY?: boolean },
  stderr: { isTTY?: boolean }
): boolean {
  return env.DEVBOX_SHELL_RECONNECT !== '0' && stdin.isTTY === true && stderr.isTTY === true
}

export function formatDevboxShellReconnectLabel(input: {
  id: number
  name?: string
  username: string
  host: string
}): string {
  const name = input.name === undefined ? '' : ` (${input.name})`
  return `shell #${input.id}${name} on ${input.username}@${input.host}`
}

export async function runDevboxShellWithReconnect(
  options: DevboxShellReconnectOptions
): Promise<DevboxShellReconnectOutcome> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const stderr = options.stderr ?? process.stderr
  const enabled = options.enabled ?? isDevboxShellReconnectEnabled(env, stdin, stderr)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const onSignal = options.onSignal ?? registerSigint
  const initialDelayMs = normalizeDelay(options.initialDelayMs, 1_000)
  const maxDelayMs = normalizeDelay(options.maxDelayMs, 15_000)
  const healthyAttachMs = options.healthyAttachMs ?? 5_000
  let delay = Math.min(initialDelayMs, maxDelayMs)
  let attempts = 0

  while (true) {
    const startedAt = now()
    const exitCode = await options.attempt()
    const elapsed = now() - startedAt
    attempts += 1

    if (exitCode !== SSH_TRANSPORT_FAILURE_EXIT_CODE || !enabled) {
      return {
        exitCode,
        attempts,
        reconnected: attempts > 1,
        abandoned: false
      }
    }

    const healthy = elapsed >= healthyAttachMs
    if (healthy) {
      delay = Math.min(initialDelayMs, maxDelayMs)
    }
    writeStderr(stderr, reconnectMessage(options.label, attempts, delay))
    notify(() => options.onReconnectWait?.({ attempt: attempts, retryInMs: Math.round(delay) }))
    const waitOutcome = await waitForReconnect(stdin, delay, sleep, onSignal)
    if (waitOutcome === 'abandon') {
      notify(() => options.onAbandon?.())
      writeStderr(stderr, "devbox: reconnect abandoned; run 'devbox shell resume' to pick this session up again.\n")
      return { exitCode: SSH_TRANSPORT_FAILURE_EXIT_CODE, attempts, reconnected: false, abandoned: true }
    }
    if (!healthy) {
      delay = Math.min(maxDelayMs, delay * 2)
    }
  }
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback
  return Number.isFinite(candidate) ? Math.max(0, candidate) : fallback
}

function reconnectMessage(label: string, attempts: number, delay: number): string {
  const nextAttempt = attempts > 1 ? ` attempt ${attempts + 1}` : ''
  return `\ndevbox: connection lost (ssh exit ${SSH_TRANSPORT_FAILURE_EXIT_CODE}) — reconnecting to ${label}${nextAttempt} in ${formatDelay(delay)}… [Enter] now · [q] quit\n`
}

function formatDelay(delay: number): string {
  if (delay % 1_000 === 0) {
    return `${delay / 1_000}s`
  }
  return `${(delay / 1_000).toFixed(1).replace(/\.0$/u, '')}s`
}

function notify(callback: () => void): void {
  try {
    callback()
  } catch {
    // Host notifications are best effort; the reconnect loop must keep running.
  }
}

function writeStderr(stderr: ReconnectStderr, message: string): void {
  try {
    stderr.write(message)
  } catch {
    // Reconnect output is best effort; the attach result remains authoritative.
  }
}

async function waitForReconnect(
  stdin: DevboxShellReconnectKeyStream,
  delay: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  onSignal: (handler: () => void) => () => void
): Promise<ReconnectWaitOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController()
    let settled = false
    let listenerRegistrationAttempted = false
    let listenerAttached = false
    let unsubscribe: (() => void) | undefined

    const onData = (chunk: Buffer | string): void => {
      let text: string
      try {
        text = typeof chunk === 'string' ? chunk : chunk.toString()
      } catch {
        return
      }
      for (const character of text) {
        if ('\r\nRr'.includes(character)) {
          finish('retry')
          return
        }
        if ('qQ\u001b\u0003'.includes(character)) {
          finish('abandon')
          return
        }
      }
    }

    const cleanup = (): void => {
      if (listenerRegistrationAttempted || listenerAttached) {
        try {
          stdin.off('data', onData)
        } catch {
          // A broken input stream must not prevent timer-based reconnect.
        }
      }
      try {
        stdin.setRawMode?.(false)
      } catch {
        // Raw mode restoration is best effort for non-standard stdin streams.
      }
      try {
        stdin.pause()
      } catch {
        // The next ssh child still gets a chance to claim fd 0.
      }
      try {
        unsubscribe?.()
      } catch {
        // Signal cleanup is best effort.
      }
      controller.abort()
    }

    const finish = (outcome: ReconnectWaitOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(outcome)
    }

    let keyInputFailed = false
    try {
      stdin.setRawMode?.(true)
    } catch {
      keyInputFailed = true
    }
    if (!keyInputFailed) {
      try {
        stdin.resume()
      } catch {
        keyInputFailed = true
      }
    }
    if (!keyInputFailed) {
      listenerRegistrationAttempted = true
      try {
        stdin.on('data', onData)
        listenerAttached = true
      } catch {
        keyInputFailed = true
      }
    }

    if (!settled) {
      try {
        unsubscribe = onSignal(() => { finish('abandon') })
      } catch {
        // A signal registration failure degrades to key/timer handling.
      }
    }
    if (settled) {
      try {
        unsubscribe?.()
      } catch {
        // Signal cleanup is best effort.
      }
      return
    }

    let timer: Promise<void>
    try {
      timer = sleep(delay, controller.signal)
    } catch {
      timer = Promise.resolve()
    }
    void timer.then(() => { finish('retry') }, () => { finish('retry') })
  })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (): void => {
      cleanup()
      resolve()
    }
    const onAbort = (): void => { finish() }
    if (signal.aborted) {
      finish()
      return
    }
    timer = setTimeout(finish, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function registerSigint(handler: () => void): () => void {
  process.once('SIGINT', handler)
  return () => { process.removeListener('SIGINT', handler) }
}
