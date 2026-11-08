import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DevboxJobLogStore } from '../../core/devbox-job-logs'
import { DevboxJobSupervisor } from '../../core/devbox-job-supervisor'
import { DevboxPortsAdapter } from '../../core/devbox-ports-adapter'
import { BoundedLoadQueue, SyntheticJobTransport, syntheticPorts } from './load-fixtures'
import { createScaleRoots, percentile } from './fixture-profile'

const JOB_COUNT = 200
const WORKER_COUNT = 24
const CONTROL_PROBES = 20
const CONTROL_P95_SLO_MS = 3_000
const CONTROL_P99_SLO_MS = 15_000

describe('Devbox synthetic process and worker load', () => {
  it('keeps control operations responsive behind bounded worker backpressure', async () => {
    const fixture = await createScaleRoots('devbox-load-')
    try {
      const transport = new SyntheticJobTransport()
      const supervisor = new DevboxJobSupervisor({
        transport,
        logs: new DevboxJobLogStore({ rootDir: join(fixture.root, 'logs') })
      })
      const portFixture = syntheticPorts()
      const ports = new DevboxPortsAdapter({
        runner: portFixture.runner,
        forwarder: portFixture.forwarder
      })
      const queue = new BoundedLoadQueue(WORKER_COUNT, JOB_COUNT + CONTROL_PROBES)
      const jobPromises: Promise<unknown>[] = []
      const controlPromises: Promise<number>[] = []

      for (let index = 0; index < JOB_COUNT; index++) {
        const id = `load-job-${String(index).padStart(3, '0')}`
        const job = queue.enqueue(async () => {
          await supervisor.launch({
            id,
            command: ['synthetic-worker', id],
            cwd: '/remote/workspace',
            detached: true
          })
          return ports.openForward({
            targetId: 'synthetic-target',
            remotePort: 4_000 + (index % WORKER_COUNT),
            remoteHost: '127.0.0.1',
            label: `worker-${index % WORKER_COUNT}`
          })
        })
        jobPromises.push(job)

        if (index === WORKER_COUNT - 1) {
          for (let probeIndex = 0; probeIndex < CONTROL_PROBES; probeIndex++) {
            controlPromises.push(
              queue.enqueue(async () => {
                const started = performance.now()
                await Promise.all([
                  supervisor.status('load-job-000'),
                  ports.inspectListener({
                    targetId: 'synthetic-target',
                    remotePort: 4_000 + (probeIndex % WORKER_COUNT)
                  })
                ])
                return performance.now() - started
              }, 10)
            )
          }
        }
      }

      const controlLatencies = await Promise.all(controlPromises)
      await Promise.all(jobPromises)
      await queue.idle()
      const p95 = percentile(controlLatencies, 0.95)
      const p99 = percentile(controlLatencies, 0.99)

      console.info(
        `synthetic load: jobs=${transport.jobs.size} workers=${WORKER_COUNT} ` +
          `queueMaxRunning=${queue.stats.maxRunning} queueMaxQueued=${queue.stats.maxQueued} ` +
          `jobTransportMaxInFlight=${transport.maxInFlight} forwardAdds=${portFixture.state.addCalls} ` +
          `forwardMaxInFlight=${portFixture.state.maxInFlight} controlP95Ms=${p95.toFixed(1)} ` +
          `controlP99Ms=${p99.toFixed(1)}`
      )
      expect(queue.stats.accepted).toBe(JOB_COUNT + CONTROL_PROBES)
      expect(queue.stats.rejected).toBe(0)
      expect(queue.stats.maxRunning).toBeLessThanOrEqual(WORKER_COUNT)
      expect(queue.stats.maxQueued).toBeLessThanOrEqual(JOB_COUNT)
      expect(transport.maxInFlight).toBeLessThanOrEqual(WORKER_COUNT)
      expect(transport.creates).toHaveLength(JOB_COUNT)
      expect(new Set(transport.creates).size).toBe(JOB_COUNT)
      expect(portFixture.state.forwards).toHaveLength(WORKER_COUNT)
      expect(portFixture.state.addCalls).toBe(WORKER_COUNT)
      expect(portFixture.state.maxInFlight).toBeLessThanOrEqual(WORKER_COUNT)
      expect(p95).toBeLessThan(CONTROL_P95_SLO_MS)
      expect(p99).toBeLessThan(CONTROL_P99_SLO_MS)
    } finally {
      await fixture.cleanup()
    }
  })
})
