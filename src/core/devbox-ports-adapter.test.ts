import { describe, expect, it, vi } from 'vitest'
import { DevboxPortsAdapter, type DevboxPortForwarder } from './devbox-ports-adapter'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { PortForwardEntry } from '../ssh/port-forward'

function forward(): PortForwardEntry {
  return {
    id: 'forward-1',
    connectionId: 'target-1',
    localPort: 43123,
    remoteHost: '127.0.0.1',
    remotePort: 3000
  }
}

describe('DevboxPortsAdapter', () => {
  it('uses the remote ss probe to classify a wildcard listener', async () => {
    const runner: DevboxSshRunner = {
      command: vi.fn(async () => 'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*\n'),
      script: vi.fn()
    }
    const adapter = new DevboxPortsAdapter({
      runner,
      forwarder: {
        openForward: vi.fn(async () => ({ entry: forward(), close: async () => undefined }))
      }
    })

    await expect(
      adapter.inspectListener({ targetId: 'target-1', remotePort: 3000 })
    ).resolves.toEqual({ address: '0.0.0.0', kind: 'wildcard' })
    expect(runner.command).toHaveBeenCalledWith('ss -H -ltn sport = :3000', 10_000)
  })

  it('does not double-forward concurrent duplicate opens', async () => {
    const entry = forward()
    const openForward = vi.fn(async () => ({ entry, close: async () => undefined }))
    const forwarder: DevboxPortForwarder = { openForward }
    const adapter = new DevboxPortsAdapter({
      runner: { command: vi.fn(), script: vi.fn() },
      forwarder
    })

    const [first, second] = await Promise.all([
      adapter.openForward({
        targetId: 'target-1',
        remotePort: 3000,
        remoteHost: '127.0.0.1'
      }),
      adapter.openForward({
        targetId: 'target-1',
        remotePort: 3000,
        remoteHost: '127.0.0.1'
      })
    ])

    expect(first).toBe(entry)
    expect(second).toBe(entry)
    expect(openForward).toHaveBeenCalledOnce()
    expect(openForward).toHaveBeenCalledWith({
      remoteHost: '127.0.0.1',
      remotePort: 3000
    })
  })
})
