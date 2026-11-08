import { describe, expect, it } from 'vitest'
import { boundedServiceExec, runBounded } from './sync-now-exec'

describe('db sync bounded exec', () => {
  it('returns output and exit code of a normal command', async () => {
    expect(await boundedServiceExec('/bin/sh', ['-c', 'echo state: running; echo note >&2; exit 0'], { timeoutMs: 5_000 }))
      .toEqual({ exitCode: 0, stdout: 'state: running\n', stderr: 'note\n' })
    expect(await boundedServiceExec('/bin/sh', ['-c', 'exit 3'], { timeoutMs: 5_000 })).toMatchObject({ exitCode: 3 })
    expect(await boundedServiceExec('/nonexistent/devbox', ['status'], { timeoutMs: 5_000 })).toMatchObject({ exitCode: 127 })
  })

  it('honours the cap even when a grandchild (curl under `devbox status`) holds the pipes', async () => {
    const started = Date.now()
    const result = await boundedServiceExec('/bin/sh', ['-c', 'sleep 30 & wait'], { timeoutMs: 200 })
    expect(result).toMatchObject({ exitCode: 124, stderr: '/bin/sh gave no answer within 200 ms' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('stops the whole process group on abort', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = runBounded('/bin/sh', ['-c', 'sleep 30 & wait'], { timeoutMs: 60_000, signal: controller.signal, killGraceMs: 100 })
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toMatchObject({ aborted: true, timedOut: false })
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
