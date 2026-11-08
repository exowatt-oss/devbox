import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REAL_SESSIONS } from './__fixtures__/sync-now-fixture'
import { createSyncNowMutagen, isConnectionError, mutagenMessage, SyncMutagenError, type SyncSpawn } from './sync-now-mutagen'

type Script = { stdout?: string; stderr?: string; code?: number; hang?: boolean }

function fakeSpawn(script: (args: readonly string[]) => Script) {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; signals: string[] }[] = []
  const spawn: SyncSpawn = (command, args, options) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const record = { command, args, env: options.env, signals: [] as string[] }
    calls.push(record)
    Object.assign(child, { stdout, stderr, exitCode: null, signalCode: null })
    const close = (code: number | null): void => {
      Object.assign(child, { exitCode: code })
      child.emit('close', code)
    }
    child.kill = ((signal: NodeJS.Signals) => {
      record.signals.push(signal)
      setImmediate(() => close(null))
      return true
    }) as ChildProcess['kill']
    const step = script(args)
    setImmediate(() => {
      if (step.stdout) {stdout.write(step.stdout)}
      if (step.stderr) {stderr.write(step.stderr)}
      if (!step.hang) {setImmediate(() => close(step.code ?? 0))}
    })
    return child
  }
  return { spawn, calls }
}

const base = { binaryPath: '/opt/mutagen', dataDirectory: '/state/mutagen', env: { HOME: '/home/u', PATH: '/bin' } }

describe('db sync Mutagen adapter', () => {
  it('lists Devbox sessions through the private daemon without autostart', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ stdout: JSON.stringify(REAL_SESSIONS) }))
    const sessions = await createSyncNowMutagen({ ...base, spawn }).list()
    expect(sessions).toHaveLength(11)
    expect(calls[0]).toMatchObject({ command: '/opt/mutagen', args: ['sync', 'list', '--label-selector=devbox-backend=mutagen', '--template', '{{json .}}'] })
    expect(calls[0]!.env).toMatchObject({ MUTAGEN_DATA_DIRECTORY: '/state/mutagen', MUTAGEN_DISABLE_AUTOSTART: '1', HOME: '/home/u' })
  })

  it('resumes/pauses one session per call, all at once, surfaces Mutagen errors, and skips empty id lists', async () => {
    const { spawn, calls } = fakeSpawn((args) => args[1] === 'pause' && args[2] === 'b' ? { stderr: 'Error: unable to pause sessions: session not found\n', code: 1 } : {})
    const mutagen = createSyncNowMutagen({ ...base, spawn })
    await mutagen.resume(['a', 'b'])
    await mutagen.resume([])
    expect(calls.map((call) => call.args)).toEqual([['sync', 'resume', 'a'], ['sync', 'resume', 'b']])
    const error = await mutagen.pause(['a', 'b']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncMutagenError)
    expect(error).toMatchObject({ message: 'unable to pause sessions: session not found', timedOut: false })
    expect(calls.slice(2).map((call) => call.args)).toEqual([['sync', 'pause', 'a'], ['sync', 'pause', 'b']])
  })

  it('caps resume (20 s) and pause (60 s) per session and marks the error as a timeout; a real error outranks it', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ hang: true }))
    const error = await createSyncNowMutagen({ ...base, spawn, timeoutMs: 20 }).resume(['a']).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ timedOut: true, message: 'mutagen sync resume gave no answer within 20 ms' })
    expect(calls[0]!.signals).toEqual(['SIGTERM'])
    const pause = await createSyncNowMutagen({ ...base, spawn, pauseTimeoutMs: 30 }).pause(['a']).catch((caught: unknown) => caught)
    expect(pause).toMatchObject({ timedOut: true, message: 'mutagen sync pause gave no answer within 30 ms' })
    const mixed = fakeSpawn((args) => args[2] === 'a' ? { hang: true } : { stderr: 'Error: unable to connect to beta: refused\n', code: 1 })
    // Generous cap: the erroring child must answer before its own cap even on a loaded runner.
    const both = await createSyncNowMutagen({ ...base, spawn: mixed.spawn, timeoutMs: 500 }).resume(['a', 'b']).catch((caught: unknown) => caught)
    expect(both).toMatchObject({ timedOut: false, message: 'unable to connect to beta: refused' })
  })

  it('flushes every session in its own child at once; the first failure stops the rest; kill stops all', async () => {
    const ok = fakeSpawn(() => ({}))
    const flushedIds: string[] = []
    expect(await createSyncNowMutagen({ ...base, spawn: ok.spawn }).flush(['a', 'b'], (id) => flushedIds.push(id)).done).toEqual({ ok: true })
    expect(ok.calls.map((call) => call.args)).toEqual([['sync', 'flush', 'a'], ['sync', 'flush', 'b']])
    expect(flushedIds.toSorted()).toEqual(['a', 'b'])

    const failed = fakeSpawn((args) => args[2] === 'a' ? { hang: true } : { stderr: 'Error: unable to flush session: session halted\n', code: 1 })
    expect(await createSyncNowMutagen({ ...base, spawn: failed.spawn }).flush(['a', 'b']).done).toEqual({ ok: false, message: 'unable to flush session: session halted' })
    expect(failed.calls[0]!.signals).toEqual(['SIGTERM'])

    const hung = fakeSpawn(() => ({ hang: true }))
    const handle = createSyncNowMutagen({ ...base, spawn: hung.spawn }).flush(['a', 'b'])
    handle.kill()
    expect((await handle.done).ok).toBe(false)
    expect(hung.calls.map((call) => call.signals)).toEqual([['SIGTERM'], ['SIGTERM']])
    expect(await createSyncNowMutagen({ ...base, spawn: hung.spawn }).flush([]).done).toEqual({ ok: true })
  })

  it('extracts the last Mutagen error line without escapes', () => {
    expect(mutagenMessage('\u001B[2KConnecting...\r\nError: unable to connect to beta: timed out\n')).toBe('unable to connect to beta: timed out')
    expect(mutagenMessage('')).toBe('')
    expect(mutagenMessage('Error: unable to dial agent endpoint: (\nConnection to UNKNOWN port 65535 timed out)\n')).toBe('Connection to UNKNOWN port 65535 timed out')
    expect(mutagenMessage('unable to resume: bad state (code 3)')).toBe('unable to resume: bad state (code 3)')
  })

  it('tells connection trouble from real session errors, reading the whole stderr', () => {
    for (const text of [
      'Connection to UNKNOWN port 65535 timed out',
      'unable to connect to beta: ssh: connect to host devbox port 22: Connection refused',
      'kex_exchange_identification: read: Connection reset by peer',
      'unable to dial agent endpoint: exit status 255',
      'Host key verification failed.',
      'ssh: Could not resolve hostname devbox: nodename nor servname provided',
      'connect to host 192.0.2.11 port 22: No route to host'
    ]) {expect(isConnectionError(new SyncMutagenError(text, false)), text).toBe(true)}
    expect(isConnectionError(new SyncMutagenError('last line only', false, 'Error: unable to connect to beta: (\nlast line only)'))).toBe(true)
    expect(isConnectionError(new SyncMutagenError('unable to resume sessions: session is halted', false))).toBe(false)
    expect(isConnectionError(new SyncMutagenError('unable to locate requested sessions', false))).toBe(false)
  })
})
