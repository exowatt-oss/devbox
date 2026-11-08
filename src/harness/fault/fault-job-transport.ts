import type {
  DevboxJobTransport,
  DevboxRemoteJob,
  DevboxRemoteJobCreateRequest
} from '../../core/devbox-job-supervisor'

export type JobLaunchFault =
  | 'create-before-register'
  | 'create-after-register'
  | 'start-before-running'
  | 'start-after-running'

export class FaultingJobTransport implements DevboxJobTransport {
  readonly jobs = new Map<string, DevboxRemoteJob>()
  createCalls = 0
  startCalls = 0
  private faultArmed = true

  constructor(private readonly fault?: JobLaunchFault) {}

  async find(id: string): Promise<DevboxRemoteJob | null> {
    return this.jobs.get(id) ?? null
  }

  async createIfAbsent(request: DevboxRemoteJobCreateRequest) {
    this.createCalls += 1
    const existing = this.jobs.get(request.id)
    if (existing) {
      return { created: false, job: existing }
    }
    if (this.shouldFault('create-before-register')) {
      throw new Error('simulated app loss before remote registration')
    }
    const job: DevboxRemoteJob = {
      id: request.id,
      specHash: request.specHash,
      unitName: request.unitName,
      cgroupPath: request.cgroupPath,
      status: 'registered'
    }
    this.jobs.set(request.id, job)
    if (this.shouldFault('create-after-register')) {
      throw new Error('simulated acknowledgement loss after registration')
    }
    return { created: true, job }
  }

  async start(job: DevboxRemoteJob): Promise<DevboxRemoteJob> {
    this.startCalls += 1
    if (this.shouldFault('start-before-running')) {
      throw new Error('simulated app loss before systemd start')
    }
    const running = { ...job, status: 'running' as const }
    this.jobs.set(job.id, running)
    if (this.shouldFault('start-after-running')) {
      throw new Error('simulated acknowledgement loss after systemd start')
    }
    return running
  }

  async cancel(job: DevboxRemoteJob): Promise<void> {
    this.jobs.set(job.id, { ...job, status: 'cancelled' })
  }

  private shouldFault(point: JobLaunchFault): boolean {
    if (this.faultArmed && this.fault === point) {
      this.faultArmed = false
      return true
    }
    return false
  }
}
