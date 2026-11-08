import { describe, expect, it } from 'vitest'
import { createLocalRunner, runLocalInteractive } from './local-runner'

describe('createLocalRunner', () => {
  it('runs bash commands and stdin scripts', async () => {
    const runner = createLocalRunner()
    await expect(runner.command("printf 'command'")).resolves.toBe('command')
    await expect(runner.script("printf 'script'")).resolves.toBe('script')
  })

  it('streams script input and includes stderr and exit status on failure', async () => {
    const runner = createLocalRunner()
    await expect(runner.command("printf 'failure' >&2; exit 23")).rejects.toMatchObject({
      message: 'Devbox local operation failed (exit 23): failure',
      exitCode: 23,
      stderr: 'failure'
    })
  })

  it('times out and marks the process error', async () => {
    const runner = createLocalRunner()
    await expect(runner.command('sleep 1', 50)).rejects.toMatchObject({
      timedOut: true,
      message: expect.stringContaining('timed out after 50ms')
    })
  })

  it('rejects NUL bytes before spawning', () => {
    const runner = createLocalRunner()
    expect(() => runner.command('printf \0')).toThrow('must not contain NUL')
    expect(() => runner.script('printf \0')).toThrow('must not contain NUL')
  })
})

describe('runLocalInteractive', () => {
  it('resolves the child exit code', async () => {
    await expect(runLocalInteractive('exit 7')).resolves.toBe(7)
  })
})
