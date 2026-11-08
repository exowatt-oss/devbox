import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DevboxJobLogStore } from './devbox-job-logs'
import {
  DevboxJobSupervisor,
  type DevboxRemoteJob,
  type DevboxJobTransport
} from './devbox-job-supervisor'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'devbox-job-'))
}

function transportFixture() {
  const jobs = new Map<string, DevboxRemoteJob>()
  const counts = { creates: 0, starts: 0 }
  let crashAfterRegistration = true
  const transport: DevboxJobTransport = {
    find: async (id) => jobs.get(id) ?? null,
    createIfAbsent: async (request) => {
      counts.creates++
      const job: DevboxRemoteJob = {
        id: request.id,
        specHash: request.specHash,
        unitName: request.unitName,
        cgroupPath: request.cgroupPath,
        status: 'registered'
      }
      jobs.set(request.id, job)
      if (crashAfterRegistration) {
        crashAfterRegistration = false
        throw new Error('simulated acknowledgement loss')
      }
      return { created: true, job }
    },
    start: async (job) => {
      counts.starts++
      const running = { ...job, status: 'running' as const }
      jobs.set(job.id, running)
      return running
    },
    cancel: async (job) => {
      jobs.set(job.id, { ...job, status: 'cancelled' })
    }
  }
  return { transport, jobs, counts }
}

const DENIED_JOB_ENVIRONMENT_KEYS = [
  'DEVBOX_BRIDGE_CAPABILITY',
  'DEVBOX_BRIDGE_TOKEN',
  'DEVBOX_CAPABILITY',
  'SERVICE_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'OAUTH_AUTHORIZATION',
  'OAUTH_AUTH_TOKEN',
  'OAUTH_AUTH_KEY',
  'OAUTH_AUTH_SECRET',
  'OAUTH_AUTH_CREDENTIAL',
  'MCP_CREDENTIAL',
  'DATABASE_PASSWORD',
  'DATABASE_PASSWD',
  'SSH_PRIVATE_KEY',
  'APP_SECRET',
  'GITHUB_TOKEN'
] as const

describe('DevboxJobSupervisor', () => {
  it('reattaches one named systemd unit across the launch/ack crash window', async () => {
    const fixture = transportFixture()
    const supervisor = new DevboxJobSupervisor({
      transport: fixture.transport,
      logs: new DevboxJobLogStore({ rootDir: root() })
    })
    const spec = {
      id: 'job-1',
      command: ['phi', '--resume'],
      cwd: '/remote',
      detached: true as const
    }
    const first = await supervisor.launch(spec)
    const second = await supervisor.launch(spec)
    expect(first.attached).toBe(true)
    expect(second.attached).toBe(true)
    expect(first.job.unitName).toContain('devbox-job-1-')
    expect(first.job.cgroupPath).toContain(first.job.unitName)
    expect(fixture.jobs.size).toBe(1)
    expect(fixture.counts.creates).toBe(1)
    await expect(
      supervisor.launch({ ...spec, command: ['different'], detached: true })
    ).rejects.toMatchObject({ context: { field: 'job-spec-hash' } })
  })

  it('starts a registered job on retry without duplicating or restarting it', async () => {
    const fixture = transportFixture()
    const supervisor = new DevboxJobSupervisor({
      transport: fixture.transport,
      logs: new DevboxJobLogStore({ rootDir: root() })
    })
    const spec = {
      id: 'job-registered',
      command: ['phi', '--resume'],
      cwd: '/remote',
      detached: true as const
    }

    const first = await supervisor.launch(spec)
    expect(first.job.status).toBe('registered')

    const retry = await supervisor.launch(spec)
    expect(retry).toMatchObject({ attached: true, job: { status: 'running' } })
    expect(fixture.jobs.size).toBe(1)
    expect(fixture.counts.creates).toBe(1)
    expect(fixture.counts.starts).toBe(1)

    const attached = await supervisor.launch(spec)
    expect(attached).toMatchObject({ attached: true, job: { status: 'running' } })
    expect(fixture.counts.starts).toBe(1)
  })

  it.each(DENIED_JOB_ENVIRONMENT_KEYS)('rejects denied environment key %s', async (key) => {
    const fixture = transportFixture()
    const supervisor = new DevboxJobSupervisor({
      transport: fixture.transport,
      logs: new DevboxJobLogStore({ rootDir: root() })
    })
    await expect(
      supervisor.launch({
        id: 'job-denied',
        command: ['phi', '--resume'],
        cwd: '/remote',
        environment: { [key]: 'synthetic-value' },
        detached: true
      })
    ).rejects.toMatchObject({
      code: 'operation_conflict',
      context: { field: 'job-environment' }
    })
    expect(fixture.counts.creates).toBe(0)
  })

  it('allows ordinary job environment variables', async () => {
    const fixture = transportFixture()
    const supervisor = new DevboxJobSupervisor({
      transport: fixture.transport,
      logs: new DevboxJobLogStore({ rootDir: root() })
    })
    await expect(
      supervisor.launch({
        id: 'job-benign',
        command: ['phi', '--resume'],
        cwd: '/remote',
        environment: {
          PATH: '/usr/local/bin:/usr/bin',
          NODE_ENV: 'test',
          CI: '1',
          SSH_AUTH_SOCK: '/tmp/agent.sock'
        },
        detached: true
      })
    ).resolves.toMatchObject({ job: { id: 'job-benign' } })
    expect(fixture.counts.creates).toBe(1)
  })

  it('rejects malformed environments before transport access', async () => {
    const fixture = transportFixture()
    const supervisor = new DevboxJobSupervisor({
      transport: fixture.transport,
      logs: new DevboxJobLogStore({ rootDir: root() })
    })
    await expect(
      supervisor.launch({
        id: 'job-malformed',
        command: ['phi'],
        cwd: '/remote',
        environment: { NODE_ENV: 1 } as never,
        detached: true
      })
    ).rejects.toMatchObject({ context: { field: 'job-environment' } })
    expect(fixture.counts.creates).toBe(0)
  })

  it('keeps workload logs sensitive, offset-addressable, and reports dropped data', () => {
    const logRoot = root()
    const logs = new DevboxJobLogStore({ perJobBytes: 256, globalBytes: 512, rootDir: logRoot })
    const supervisor = new DevboxJobSupervisor({ transport: transportFixture().transport, logs })
    supervisor.appendLog('job-1', 'a'.repeat(200))
    supervisor.appendLog('job-1', 'b'.repeat(100))
    expect(existsSync(`${supervisor.logPath('job-1')}.1`)).toBe(true)
    const result = supervisor.appendLog('job-1', 'x'.repeat(1_000))
    expect(result.droppedBytes).toBeGreaterThan(0)
    const tail = supervisor.tailLog('job-1', 0, 1_024)
    expect(tail.sensitive).toBe(true)
    expect(tail.includeInDiagnostics).toBe(false)
    expect(tail.droppedMarkers.length).toBeGreaterThan(0)
    expect(statSync(supervisor.logPath('job-1')).mode & 0o777).toBe(0o600)
  })
})
