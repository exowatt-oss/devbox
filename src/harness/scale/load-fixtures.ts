import type {
  DevboxJobTransport,
  DevboxRemoteJob,
  DevboxRemoteJobCreateRequest
} from '../../core/devbox-job-supervisor'
import type { PortForwardEntry } from '../../ssh/port-forward'

export type QueueStats = {
  maxRunning: number
  maxQueued: number
  accepted: number
  rejected: number
}

type QueuedTask = {
  priority: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class BoundedLoadQueue {
  readonly stats: QueueStats = { maxRunning: 0, maxQueued: 0, accepted: 0, rejected: 0 }
  private readonly tasks: QueuedTask[] = []
  private running = 0
  private draining = false

  constructor(
    private readonly workerCount: number,
    private readonly capacity: number
  ) {}

  enqueue<T>(run: () => Promise<T>, priority = 0): Promise<T> {
    if (this.running + this.tasks.length >= this.capacity) {
      this.stats.rejected++
      return Promise.reject(new Error('synthetic load queue capacity reached'))
    }
    this.stats.accepted++
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({
        priority,
        run: async () => run(),
        resolve: (value) => resolve(value as T),
        reject
      })
      this.stats.maxQueued = Math.max(this.stats.maxQueued, this.tasks.length)
      void this.drain()
    })
  }

  async idle(): Promise<void> {
    while (this.running > 0 || this.tasks.length > 0 || this.draining) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      while (this.running < this.workerCount && this.tasks.length > 0) {
        this.tasks.sort((left, right) => right.priority - left.priority)
        const task = this.tasks.shift()!
        this.running++
        this.stats.maxRunning = Math.max(this.stats.maxRunning, this.running)
        void task
          .run()
          .then(task.resolve, task.reject)
          .finally(() => {
            this.running--
            void this.drain()
          })
      }
    } finally {
      this.draining = false
    }
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export class SyntheticJobTransport implements DevboxJobTransport {
  readonly jobs = new Map<string, DevboxRemoteJob>()
  readonly creates: string[] = []
  maxInFlight = 0
  private inFlight = 0

  async find(id: string): Promise<DevboxRemoteJob | null> {
    await this.track()
    return this.jobs.get(id) ?? null
  }

  async createIfAbsent(request: DevboxRemoteJobCreateRequest) {
    await this.track()
    const existing = this.jobs.get(request.id)
    if (existing) {
      return { created: false, job: existing }
    }
    const job: DevboxRemoteJob = {
      id: request.id,
      specHash: request.specHash,
      unitName: request.unitName,
      cgroupPath: request.cgroupPath,
      status: 'registered'
    }
    this.jobs.set(request.id, job)
    this.creates.push(request.id)
    return { created: true, job }
  }

  async start(job: DevboxRemoteJob): Promise<DevboxRemoteJob> {
    await this.track()
    const running = { ...job, status: 'running' as const }
    this.jobs.set(job.id, running)
    return running
  }

  async cancel(job: DevboxRemoteJob): Promise<void> {
    await this.track()
    this.jobs.set(job.id, { ...job, status: 'cancelled' })
  }

  async wait(job: DevboxRemoteJob): Promise<DevboxRemoteJob> {
    return this.jobs.get(job.id) ?? job
  }

  private async track(): Promise<void> {
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await delay(1)
    } finally {
      this.inFlight--
    }
  }
}

export type SyntheticPorts = {
  forwards: PortForwardEntry[]
  addCalls: number
  maxInFlight: number
}

export function syntheticPorts(): {
  runner: { command: (command: string, timeoutMs?: number) => Promise<string>; script: (script: string, timeoutMs?: number) => Promise<string> }
  forwarder: {
    openForward: (input: {
      remoteHost: string
      remotePort: number
      label?: string
    }) => Promise<{ entry: PortForwardEntry; close(): Promise<void> }>
  }
  state: SyntheticPorts
} {
  const state: SyntheticPorts = { forwards: [], addCalls: 0, maxInFlight: 0 }
  let inFlight = 0
  let nextLocalPort = 45_000
  const forwarder = {
    openForward: async (input: {
      remoteHost: string
      remotePort: number
      label?: string
    }): Promise<{ entry: PortForwardEntry; close(): Promise<void> }> => {
      inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, inFlight)
      state.addCalls++
      try {
        await delay(1)
      } finally {
        inFlight--
      }
      const entry: PortForwardEntry = {
        id: `synthetic-forward-${String(state.addCalls)}`,
        connectionId: 'synthetic-target',
        localPort: nextLocalPort++,
        remoteHost: input.remoteHost,
        remotePort: input.remotePort,
        ...(input.label ? { label: input.label } : {})
      }
      state.forwards.push(entry)
      return { entry, close: async () => {} }
    }
  }
  const runner = {
    command: async (command: string): Promise<string> => {
      await delay(1)
      const match = /sport = :(\d+)/.exec(command)
      const port = match ? Number(match[1]) : 0
      return `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`
    },
    script: async (): Promise<string> => {
      await delay(1)
      return ''
    }
  }
  return { runner, forwarder, state }
}
