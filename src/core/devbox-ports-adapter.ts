import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import { createSshPortForwarder, type PortForwardEntry } from '../ssh/port-forward'
import type { DevboxPortAdapter } from './devbox-orchestrator-types'

/** The small seam used by Devbox core; the SSH module owns process lifecycle. */
export type DevboxPortForwarder = {
  openForward(input: {
    remoteHost: string
    remotePort: number
    label?: string
  }): Promise<{ entry: PortForwardEntry; close(): Promise<void> }>
}

export type DevboxPortsOptions = {
  runner: DevboxSshRunner
  /** Injected in tests or by an application embedding Devbox. */
  forwarder?: DevboxPortForwarder
  /** Used when no forwarder is injected. */
  endpoint?: SshEndpoint
}

export class DevboxPortsAdapter implements DevboxPortAdapter {
  private readonly runner: DevboxSshRunner
  private readonly forwarder: DevboxPortForwarder | null
  private readonly pending = new Map<string, Promise<PortForwardEntry>>()
  private readonly active = new Map<string, { entry: PortForwardEntry; close(): Promise<void> }>()

  constructor(options: DevboxPortsOptions) {
    this.runner = options.runner
    this.forwarder = options.forwarder ?? (options.endpoint ? createSshPortForwarder(options.endpoint) : null)

  }

  async inspectListener(input: { targetId: string; remotePort: number }) {
    assertPort(input.remotePort)
    const output = await this.runner.command(
      `ss -H -ltn sport = :${input.remotePort}`,
      10_000
    )
    const address = parseSsAddress(output, input.remotePort)
    if (!address) {
      throw blocked('listener-not-found')
    }
    return listenerFromAddress(address)
  }

  async openForward(input: {
    targetId: string
    remotePort: number
    remoteHost: string
    label?: string
  }): Promise<PortForwardEntry> {
    assertPort(input.remotePort)
    const forwarder = this.forwarder
    if (!forwarder) {
      throw blocked('port-forward-authority')
    }
    const idempotencyKey = [input.targetId, input.remoteHost, input.remotePort].join(':')
    // An existing open forward for the same target/host/port is reused rather
    // than opening a second tunnel.
    const active = this.active.get(idempotencyKey)
    if (active) {
      return active.entry
    }
    const pending = this.pending.get(idempotencyKey)
    if (pending) {
      return pending
    }
    const operation = this.createForward(forwarder, input)
    this.pending.set(idempotencyKey, operation)
    try {
      return await operation
    } finally {
      this.pending.delete(idempotencyKey)
    }
  }

  private async createForward(
    forwarder: DevboxPortForwarder,
    input: {
      targetId: string
      remotePort: number
      remoteHost: string
      label?: string
    }
  ): Promise<PortForwardEntry> {
    // The standalone SSH forwarder allocates and probes a 127.0.0.1 listener;
    // targetId is used by Devbox's coalescing key, not passed to OpenSSH.
    void input.targetId
    const result = await forwarder.openForward({
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      ...(input.label === undefined ? {} : { label: input.label })
    })
    const idempotencyKey = [input.targetId, input.remoteHost, input.remotePort].join(':')
    this.active.set(idempotencyKey, result)
    return result.entry
  }

  /** Close every forward this adapter opened (disable/cleanup path). */
  async closeAll(): Promise<void> {
    const open = [...this.active.values()]
    this.active.clear()
    await Promise.allSettled(open.map((forward) => forward.close()))
  }
}

function listenerFromAddress(address: string): {
  address: string
  kind: 'loopback' | 'wildcard' | 'other'
} {
  const normalized = address.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '*') {
    return { address: normalized, kind: 'wildcard' }
  }
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.')
  ) {
    return { address: normalized, kind: 'loopback' }
  }
  return { address: normalized, kind: 'other' }
}

function parseSsAddress(output: string, remotePort: number): string | null {
  const suffix = `:${remotePort}`
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const local = fields.find((field) => field.endsWith(suffix))
    if (local) {
      return local.slice(0, -suffix.length)
    }
  }
  return null
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw blocked('remote-port')
  }
}

function blocked(field: string) {
  return createDevboxError('operation_conflict', { context: { field } })
}

export { listenerFromAddress as classifyDevboxListener }

/** Public alias for consumers of the standalone adapter surface. */
export { DevboxPortsAdapter as DevboxStandalonePortsAdapter }
