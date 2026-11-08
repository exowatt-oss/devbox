import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVBOX_HANDLERS, type HandlerContext } from './handlers'
import type { DevboxServiceLike } from './operations'
import { localExec } from './preflight'

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('preflight CLI', () => {
  it('executes local preflight commands with argv and returns their output', async () => {
    const result = await localExec({
      command: process.execPath,
      args: ['-e', "process.stdout.write(process.argv[1])", 'local-inventory']
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'local-inventory', stderr: '' })
  })

  it('normalizes local command failures to the preflight result shape', async () => {
    const result = await localExec({
      command: process.execPath,
      args: ['-e', "process.stderr.write('local failure'); process.exit(7)"]
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('local failure')
  })

  it('prints blockers and exits one when the service reports blocked', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const service = {
      preflight: vi.fn(async () => ({
        status: 'blocked',
        blockedReason: 'ssh-unreachable',
        blockers: [{ id: 'ssh-reachability', remediation: 'Reconnect and retry.' }]
      }))
    } as unknown as DevboxServiceLike
    const context: HandlerContext = {
      flags: new Map([['profile', 'p1']]),
      service,
      cwd: '/tmp',
      json: false
    }
    await DEVBOX_HANDLERS.preflight(context)
    expect(output.mock.calls.join('\n')).toContain('ssh-reachability')
    expect(process.exitCode).toBe(1)
  })
})
