import { createHash } from 'node:crypto'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import { validateDevboxJobEnvironment } from '../shared/devbox-job-environment'
import type { DevboxJobLogStore, DevboxJobLogTail } from './devbox-job-logs'

export type DevboxJobSpec = {
  id: string
  command: readonly string[]
  cwd: string
  environment?: Readonly<Record<string, string>>
  detached?: boolean
}

export type DevboxRemoteJob = {
  id: string
  specHash: string
  unitName: string
  cgroupPath: string
  status: 'registered' | 'running' | 'completed' | 'failed' | 'cancelled'
  exitCode?: number
}

export type DevboxRemoteJobCreateRequest = {
  id: string
  specHash: string
  unitName: string
  cgroupPath: string
  spec: DevboxJobSpec
}

export type DevboxJobTransport = {
  find(id: string): Promise<DevboxRemoteJob | null>
  createIfAbsent(request: DevboxRemoteJobCreateRequest): Promise<{
    created: boolean
    job: DevboxRemoteJob
  }>
  start(job: DevboxRemoteJob): Promise<DevboxRemoteJob>
  cancel(job: DevboxRemoteJob): Promise<void>
  wait?(job: DevboxRemoteJob): Promise<DevboxRemoteJob>
}

export type DevboxJobLaunchResult = {
  job: DevboxRemoteJob
  attached: boolean
}

export type DevboxJobSupervisorOptions = {
  transport: DevboxJobTransport
  logs: DevboxJobLogStore
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function stableSpec(spec: DevboxJobSpec): string {
  return JSON.stringify({
    id: spec.id,
    command: [...spec.command],
    cwd: spec.cwd,
    environment: Object.fromEntries(Object.entries(spec.environment ?? {}).sort()),
    detached: spec.detached === true
  })
}

function hashSpec(spec: DevboxJobSpec): string {
  return createHash('sha256').update(stableSpec(spec)).digest('hex')
}

function unitName(id: string, specHash: string): string {
  return `devbox-${id}-${specHash.slice(0, 16)}.service`
}

function invalidJob(field: string): DevboxError {
  return createDevboxError('operation_conflict', { context: { field } })
}

export class DevboxJobSupervisor {
  private readonly transport: DevboxJobTransport
  private readonly logs: DevboxJobLogStore
  private readonly jobs = new Map<string, DevboxRemoteJob>()

  constructor(options: DevboxJobSupervisorOptions) {
    this.transport = options.transport
    this.logs = options.logs
  }

  async launch(spec: DevboxJobSpec): Promise<DevboxJobLaunchResult> {
    this.validateSpec(spec)
    const specHash = hashSpec(spec)
    const name = unitName(spec.id, specHash)
    const known = await this.transport.find(spec.id)
    if (known) {
      this.assertMatch(known, specHash, name)
      this.jobs.set(spec.id, known)
      return this.startRegisteredJob(known, specHash, name, true)
    }
    const request: DevboxRemoteJobCreateRequest = {
      id: spec.id,
      specHash,
      unitName: name,
      cgroupPath: `/sys/fs/cgroup/system.slice/${name}`,
      spec
    }
    let created: { created: boolean; job: DevboxRemoteJob }
    try {
      created = await this.transport.createIfAbsent(request)
    } catch (error) {
      return this.recoverLaunchCrash(spec.id, specHash, name, error)
    }
    this.assertMatch(created.job, specHash, name)
    this.jobs.set(spec.id, created.job)
    if (created.job.status === 'registered') {
      return this.startRegisteredJob(created.job, specHash, name, !created.created)
    }
    return { job: created.job, attached: !created.created }
  }

  async cancel(id: string): Promise<void> {
    const job = await this.get(id)
    await this.transport.cancel(job)
    this.jobs.set(id, { ...job, status: 'cancelled' })
  }

  async waitForCompletion(id: string): Promise<DevboxRemoteJob> {
    const job = await this.get(id)
    const completed = this.transport.wait ? await this.transport.wait(job) : job
    this.jobs.set(id, completed)
    return completed
  }

  async status(id: string): Promise<DevboxRemoteJob | null> {
    if (!ID_PATTERN.test(id)) {
      throw invalidJob('job-id')
    }
    const job = await this.transport.find(id)
    if (job) {
      this.jobs.set(id, job)
    }
    return job
  }

  appendLog(id: string, text: string) {
    return this.logs.append(id, text)
  }

  tailLog(id: string, offset = 0, limit = 64 * 1024): DevboxJobLogTail {
    return this.logs.tail(id, offset, limit)
  }

  async tailLogLive(id: string, offset = 0, limit = 64 * 1024): Promise<DevboxJobLogTail> {
    const transport = this.transport as DevboxJobTransport & { syncLog?: (jobId: string) => Promise<void> }
    await transport.syncLog?.(id)
    return this.tailLog(id, offset, limit)
  }

  logPath(id: string): string {
    return this.logs.pathFor(id)
  }

  activeCount(): number {
    return [...this.jobs.values()].filter(
      (job) => job.status === 'registered' || job.status === 'running'
    ).length
  }

  private async get(id: string): Promise<DevboxRemoteJob> {
    if (!ID_PATTERN.test(id)) {
      throw invalidJob('job-id')
    }
    const job = this.jobs.get(id) ?? (await this.transport.find(id))
    if (!job) {
      throw createDevboxError('profile_not_found', { context: { field: 'job-id' } })
    }
    this.jobs.set(id, job)
    return job
  }

  private async startRegisteredJob(
    job: DevboxRemoteJob,
    specHash: string,
    name: string,
    attached: boolean
  ): Promise<DevboxJobLaunchResult> {
    if (job.status !== 'registered') {
      return { job, attached }
    }
    try {
      const started = await this.transport.start(job)
      this.assertMatch(started, specHash, name)
      const running =
        started.status === 'registered' && this.transport.find
          ? (await this.transport.find(job.id)) ?? started
          : started
      if (running.status === 'registered') {
        throw createDevboxError('operation_conflict', { context: { field: 'job-not-running' } })
      }
      this.assertMatch(running, specHash, name)
      this.jobs.set(job.id, running)
      return { job: running, attached }
    } catch (error) {
      return this.recoverLaunchCrash(job.id, specHash, name, error)
    }
  }

  private async recoverLaunchCrash(
    id: string,
    specHash: string,
    name: string,
    cause: unknown
  ): Promise<DevboxJobLaunchResult> {
    const recovered = await this.transport.find(id)
    if (recovered) {
      this.assertMatch(recovered, specHash, name)
      this.jobs.set(id, recovered)
      return { job: recovered, attached: true }
    }
    if (cause && typeof cause === 'object' && 'code' in cause) {
      throw cause
    }
    throw createDevboxError('unknown', { retryable: true, context: { field: 'job-launch' } })
  }

  private validateSpec(spec: DevboxJobSpec): void {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !ID_PATTERN.test(spec.id)) {
      throw invalidJob('job-id')
    }
    if (!Array.isArray(spec.command) || spec.command.length === 0) {
      throw invalidJob('job-command')
    }
    if (!spec.cwd || spec.cwd.includes('\u0000')) {
      throw invalidJob('job-cwd')
    }
    if (spec.detached !== true) {
      throw invalidJob('detached-required')
    }
    for (const value of spec.command) {
      if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
        throw invalidJob('job-command')
      }
    }
    if (!validateDevboxJobEnvironment(spec.environment).ok) {
      throw invalidJob('job-environment')
    }
  }

  private assertMatch(job: DevboxRemoteJob, specHash: string, name: string): void {
    if (
      job.specHash !== specHash ||
      job.unitName !== name ||
      job.cgroupPath !== `/sys/fs/cgroup/system.slice/${name}`
    ) {
      throw invalidJob('job-spec-hash')
    }
  }
}

export { hashSpec as hashDevboxJobSpec }
