import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevboxJobLogStore } from '../../core/devbox-job-logs'
import { DevboxJobSupervisor } from '../../core/devbox-job-supervisor'
import { FaultingJobTransport, type JobLaunchFault } from './fault-job-transport'

const logRoots: string[] = []

afterEach(() => {
  for (const root of logRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const jobSpec = {
  id: 'fault-job',
  command: ['phi', '--resume'],
  cwd: '/remote/workspace',
  detached: true as const
}

function supervisor(transport: FaultingJobTransport): DevboxJobSupervisor {
  const logRoot = mkdtempSync(join(tmpdir(), 'devbox-fault-job-'))
  logRoots.push(logRoot)
  return new DevboxJobSupervisor({
    transport,
    logs: new DevboxJobLogStore({ rootDir: logRoot })
  })
}

describe('Devbox fault harness: atomic job launch and app restart', () => {
  it.each<JobLaunchFault>([
    'create-before-register',
    'create-after-register',
    'start-before-running',
    'start-after-running'
  ])('retries idempotently after %s without a duplicate or orphan', async (fault) => {
    const transport = new FaultingJobTransport(fault)
    const firstSupervisor = supervisor(transport)

    let firstStatus: string | undefined
    let firstThrew = false
    try {
      firstStatus = (await firstSupervisor.launch(jobSpec)).job.status
    } catch {
      firstThrew = true
    }

    const restarted = supervisor(transport)
    const retried = await restarted.launch(jobSpec)
    expect(retried.job.status).toBe('running')
    expect(retried.job.id).toBe(jobSpec.id)
    expect(transport.jobs.size).toBe(1)
    expect([...transport.jobs.values()]).toEqual([
      expect.objectContaining({ id: jobSpec.id, status: 'running' })
    ])
    if (fault === 'create-before-register') {
      expect(firstThrew).toBe(true)
      expect(firstStatus).toBeUndefined()
      expect(transport.createCalls).toBe(2)
    } else {
      expect(firstThrew).toBe(false)
      expect(firstStatus).toBe(fault === 'start-after-running' ? 'running' : 'registered')
      expect(transport.createCalls).toBe(1)
    }
    expect(transport.startCalls).toBe(
      fault === 'create-before-register' ? 1 : fault === 'start-before-running' ? 2 : 1
    )
  })

  async function statusAfterRestart(fault: JobLaunchFault): Promise<string> {
    const transport = new FaultingJobTransport(fault)
    await expect(supervisor(transport).launch(jobSpec)).resolves.toBeDefined()
    return (await supervisor(transport).launch(jobSpec)).job.status
  }

  it('completes a registered job on retry after create acknowledgement loss', async () => {
    await expect(statusAfterRestart('create-after-register')).resolves.toBe('running')
  })

  it('completes a registered job on retry after start acknowledgement loss', async () => {
    await expect(statusAfterRestart('start-before-running')).resolves.toBe('running')
  })

  it('rejects a retry with a different spec instead of reusing the registered job', async () => {
    const transport = new FaultingJobTransport('create-after-register')
    const first = supervisor(transport)
    await first.launch(jobSpec)

    await expect(
      supervisor(transport).launch({ ...jobSpec, command: ['different-command'] })
    ).rejects.toMatchObject({ context: { field: 'job-spec-hash' } })
    expect(transport.jobs.size).toBe(1)
  })

  it.skip('real Mutagen/OpenSSH/remote transport fault matrix requires a Mutagen binary and a real OpenSSH host', () =>
    undefined)
})
