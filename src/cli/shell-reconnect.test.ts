import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  formatDevboxShellReconnectLabel,
  isDevboxShellReconnectEnabled,
  runDevboxShellWithReconnect,
  type DevboxShellReconnectKeyStream
} from './shell-reconnect'

type FakeStdin = {
  stdin: DevboxShellReconnectKeyStream
  calls: string[]
  emit: (chunk: Buffer | string) => void
  listenerCount: () => number
}

type PendingSleep = {
  ms: number
  signal: AbortSignal
  resolve: () => void
}

function makeStdin(): FakeStdin {
  const emitter = new EventEmitter()
  const calls: string[] = []
  const stdin: DevboxShellReconnectKeyStream = {
    isTTY: true,
    setRawMode: vi.fn((mode: boolean) => { calls.push(`raw:${mode}`) }),
    resume: vi.fn(() => { calls.push('resume') }),
    pause: vi.fn(() => { calls.push('pause') }),
    on: vi.fn((event: 'data', listener: (chunk: Buffer | string) => void) => {
      calls.push('on')
      emitter.on(event, listener)
      return undefined
    }),
    off: vi.fn((event: 'data', listener: (chunk: Buffer | string) => void) => {
      calls.push('off')
      emitter.off(event, listener)
      return undefined
    })
  }
  return {
    stdin,
    calls,
    emit: (chunk) => { emitter.emit('data', chunk) },
    listenerCount: () => emitter.listenerCount('data')
  }
}

function makeSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; pending: PendingSleep[] } {
  const pending: PendingSleep[] = []
  const sleep = vi.fn((ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    pending.push({ ms, signal, resolve })
  }))
  return { sleep, pending }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function stderr(): { isTTY: boolean; writes: string[]; write: (chunk: string) => boolean } {
  const writes: string[] = []
  return { isTTY: true, writes, write: (chunk) => { writes.push(chunk); return true } }
}

describe('devbox shell reconnect', () => {
  it('formats labels and only enables reconnect for TTY streams', () => {
    expect(formatDevboxShellReconnectLabel({ id: 7, name: 'betterssh', username: 'sample', host: '203.0.113.10' }))
      .toBe('shell #7 (betterssh) on sample@203.0.113.10')
    expect(formatDevboxShellReconnectLabel({ id: 7, username: 'sample', host: '203.0.113.10' }))
      .toBe('shell #7 on sample@203.0.113.10')
    expect(isDevboxShellReconnectEnabled({}, { isTTY: true }, { isTTY: true })).toBe(true)
    expect(isDevboxShellReconnectEnabled({ DEVBOX_SHELL_RECONNECT: '0' }, { isTTY: true }, { isTTY: true })).toBe(false)
    expect(isDevboxShellReconnectEnabled({}, { isTTY: false }, { isTTY: true })).toBe(false)
  })

  it('returns immediately for a non-transport exit code', async () => {
    const input = makeStdin()
    const output = stderr()
    const outcome = await runDevboxShellWithReconnect({
      attempt: async () => 0,
      label: 'shell #1 on sample@host',
      enabled: true,
      stdin: input.stdin,
      stderr: output
    })
    expect(outcome).toEqual({ exitCode: 0, attempts: 1, reconnected: false, abandoned: false })
    expect(output.writes).toEqual([])
  })

  it('returns a disabled transport failure without waiting', async () => {
    const input = makeStdin()
    const output = stderr()
    const sleep = vi.fn(async () => {})
    const outcome = await runDevboxShellWithReconnect({
      attempt: async () => 255,
      label: 'shell #1 on sample@host',
      enabled: false,
      stdin: input.stdin,
      stderr: output,
      sleep
    })
    expect(outcome).toEqual({ exitCode: 255, attempts: 1, reconnected: false, abandoned: false })
    expect(sleep).not.toHaveBeenCalled()
    expect(output.writes).toEqual([])
  })

  it('retries after a timer and reports a successful reconnect', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    const attempt = vi.fn().mockResolvedValueOnce(255).mockResolvedValueOnce(0)
    const run = runDevboxShellWithReconnect({
      attempt,
      label: 'shell #1 on sample@host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      sleep: timer.sleep
    })
    await flush()
    expect(timer.pending[0]?.ms).toBe(1_000)
    timer.pending[0]!.resolve()
    const outcome = await run
    expect(outcome).toEqual({ exitCode: 0, attempts: 2, reconnected: true, abandoned: false })
  })

  it('uses Enter for an immediate retry and aborts the sleep signal', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    const attempt = vi.fn().mockResolvedValueOnce(255).mockResolvedValueOnce(0)
    const run = runDevboxShellWithReconnect({
      attempt,
      label: 'shell #1 on sample@host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      sleep: timer.sleep
    })
    await flush()
    input.emit('\r')
    const outcome = await run
    expect(timer.pending[0]!.signal.aborted).toBe(true)
    expect(outcome).toEqual({ exitCode: 0, attempts: 2, reconnected: true, abandoned: false })
  })

  it('abandons on q and tells the user how to resume', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    const run = runDevboxShellWithReconnect({
      attempt: async () => 255,
      label: 'shell #7 (betterssh) on sample@host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      sleep: timer.sleep
    })
    await flush()
    input.emit('q')
    const outcome = await run
    expect(outcome).toEqual({ exitCode: 255, attempts: 1, reconnected: false, abandoned: true })
    expect(output.writes.join('')).toContain("devbox: reconnect abandoned; run 'devbox shell resume' to pick this session up again.")
  })

  it('doubles fast-failure backoff and caps it at maxDelayMs', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    let nowValue = 0
    let count = 0
    const attempt = vi.fn(async () => {
      nowValue += 1
      count += 1
      return count === 5 ? 0 : 255
    })
    const run = runDevboxShellWithReconnect({
      attempt,
      label: 'shell #1 on host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      initialDelayMs: 10,
      maxDelayMs: 40,
      now: () => nowValue,
      sleep: timer.sleep
    })
    for (let index = 0; index < 4; index += 1) {
      await flush()
      expect(timer.pending[index]?.ms).toBe([10, 20, 40, 40][index])
      timer.pending[index]!.resolve()
    }
    expect(await run).toEqual({ exitCode: 0, attempts: 5, reconnected: true, abandoned: false })
  })

  it('resets the delay after a healthy attach duration', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    let nowIndex = 0
    const nowValues = [0, 1, 1, 7, 7, 8]
    let count = 0
    const attempt = vi.fn(async () => {
      count += 1
      return count === 3 ? 0 : 255
    })
    const run = runDevboxShellWithReconnect({
      attempt,
      label: 'shell #1 on host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      initialDelayMs: 10,
      maxDelayMs: 40,
      healthyAttachMs: 5,
      now: () => nowValues[nowIndex++]!,
      sleep: timer.sleep
    })
    await flush()
    expect(timer.pending[0]?.ms).toBe(10)
    timer.pending[0]!.resolve()
    await flush()
    expect(timer.pending[1]?.ms).toBe(10)
    timer.pending[1]!.resolve()
    expect(await run).toEqual({ exitCode: 0, attempts: 3, reconnected: true, abandoned: false })
  })

  it('cleans up stdin before every retry attempt', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    let count = 0
    const attempt = vi.fn(async () => {
      count += 1
      if (count > 1) {
        expect(input.listenerCount()).toBe(0)
        expect(input.calls.slice(-3)).toEqual(['off', 'raw:false', 'pause'])
      }
      return count === 3 ? 0 : 255
    })
    const run = runDevboxShellWithReconnect({
      attempt,
      label: 'shell #1 on host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      sleep: timer.sleep
    })
    await flush()
    timer.pending[0]!.resolve()
    await flush()
    timer.pending[1]!.resolve()
    expect(await run).toEqual({ exitCode: 0, attempts: 3, reconnected: true, abandoned: false })
  })

  it('abandons when SIGINT arrives during the wait', async () => {
    const input = makeStdin()
    const output = stderr()
    const timer = makeSleep()
    let signalHandler: (() => void) | undefined
    const run = runDevboxShellWithReconnect({
      attempt: async () => 255,
      label: 'shell #1 on host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      sleep: timer.sleep,
      onSignal: (handler) => {
        signalHandler = handler
        return () => {}
      }
    })
    await flush()
    signalHandler!()
    expect(await run).toMatchObject({ exitCode: 255, abandoned: true })
  })

  it('degrades to timer-only retry when setRawMode fails', async () => {
    const input = makeStdin()
    input.stdin.setRawMode = vi.fn((mode: boolean) => {
      if (mode) {
        throw new Error('not a tty')
      }
    })
    const output = stderr()
    const timer = makeSleep()
    const attempt = vi.fn().mockResolvedValueOnce(255).mockResolvedValueOnce(0)
    const run = runDevboxShellWithReconnect({
      attempt,
      label: 'shell #1 on host',
      enabled: true,
      stdin: input.stdin,
      stderr: output,
      sleep: timer.sleep
    })
    await flush()
    timer.pending[0]!.resolve()
    expect(await run).toMatchObject({ exitCode: 0, attempts: 2, reconnected: true })
  })

  it('announces each reconnect wait and an abandon to the host, surviving a throwing callback', async () => {
    const input = makeStdin()
    const timer = makeSleep()
    const waits: { attempt: number; retryInMs: number }[] = []
    const onAbandon = vi.fn(() => { throw new Error('host hook failed') })
    const run = runDevboxShellWithReconnect({
      attempt: async () => 255,
      label: 'shell #1 on sample@host',
      enabled: true,
      stdin: input.stdin,
      stderr: stderr(),
      sleep: timer.sleep,
      onReconnectWait: (wait) => { waits.push(wait); if (wait.attempt === 1) {throw new Error('host hook failed')} },
      onAbandon
    })
    await flush()
    timer.pending[0]!.resolve()
    await flush()
    expect(waits).toEqual([{ attempt: 1, retryInMs: 1_000 }, { attempt: 2, retryInMs: 2_000 }])
    input.emit('q')
    await expect(run).resolves.toMatchObject({ exitCode: 255, attempts: 2, abandoned: true })
    expect(onAbandon).toHaveBeenCalledOnce()
  })

  it('does not announce a wait for a clean exit or a disabled reconnect', async () => {
    const onReconnectWait = vi.fn()
    for (const [exitCode, enabled] of [[0, true], [255, false]] as const) {
      await runDevboxShellWithReconnect({ attempt: async () => exitCode, label: 'x', enabled, stdin: makeStdin().stdin, stderr: stderr(), onReconnectWait })
    }
    expect(onReconnectWait).not.toHaveBeenCalled()
  })
})

