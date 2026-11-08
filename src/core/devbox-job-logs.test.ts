import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectBundle } from './diagnostics-bundle'
import { DevboxJobLogStore } from './devbox-job-logs'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devbox-job-logs-'))
  roots.push(value)
  return value
}

function familyBytes(logs: DevboxJobLogStore, jobId: string): number {
  return [logs.pathFor(jobId), `${logs.pathFor(jobId)}.1`]
    .filter((path) => existsSync(path))
    .reduce((total, path) => total + statSync(path).size, 0)
}

afterEach(() => {
  while (roots.length > 0) {
    const path = roots.pop()
    if (path) {
      rmSync(path, { force: true, recursive: true })
    }
  }
})

describe('DevboxJobLogStore quotas', () => {
  it('keeps the exact audit case within the per-job quota after rotation', () => {
    const logs = new DevboxJobLogStore({ rootDir: root(), perJobBytes: 100, globalBytes: 200 })

    logs.append('job-1', 'x'.repeat(100))
    const result = logs.append('job-1', 'x')

    expect(result.droppedBytes).toBe(1)
    expect(result.droppedMarker).toContain('dropped 1 bytes')
    expect(familyBytes(logs, 'job-1')).toBeLessThanOrEqual(100)
    expect(logs.tail('job-1').droppedMarkers).toContain(result.droppedMarker)
  })

  it('fits the actual marker and reports exactly the dropped input bytes', () => {
    const logs = new DevboxJobLogStore({ rootDir: root(), perJobBytes: 120, globalBytes: 240 })

    logs.append('job-2', 'a'.repeat(20))
    const input = 'b'.repeat(200)
    const result = logs.append('job-2', input)
    const current = readFileSync(logs.pathFor('job-2'), 'utf8')
    const markerStart = current.indexOf('[devbox dropped ')
    const prefix = current.slice(0, markerStart)
    const reported = Number(current.match(/dropped (\d+) bytes/)?.[1])

    expect(markerStart).toBeGreaterThanOrEqual(0)
    expect(reported).toBe(result.droppedBytes)
    expect(Buffer.byteLength(prefix) + reported).toBe(Buffer.byteLength(input))
    expect(
      Buffer.byteLength(current) + statSync(`${logs.pathFor('job-2')}.1`).size
    ).toBeLessThanOrEqual(120)
    expect(statSync(logs.pathFor('job-2')).mode & 0o777).toBe(0o600)
    expect(statSync(`${logs.pathFor('job-2')}.1`).mode & 0o777).toBe(0o600)
  })

  it('never exceeds the global quota when another job is full', () => {
    const logs = new DevboxJobLogStore({ rootDir: root(), perJobBytes: 100, globalBytes: 150 })

    logs.append('job-1', 'a'.repeat(100))
    const result = logs.append('job-2', 'b'.repeat(100))

    expect(result.droppedBytes).toBe(100)
    expect(familyBytes(logs, 'job-1') + familyBytes(logs, 'job-2')).toBeLessThanOrEqual(150)
    expect(logs.tail('job-2').droppedMarkers[0]).toContain('dropped 100 bytes')
  })
})

describe('default diagnostics workload exclusion', () => {
  it('excludes registered workload logs while retaining ordinary diagnostics', () => {
    const logRoot = root()
    const logs = new DevboxJobLogStore({ rootDir: logRoot })
    const jobPath = logs.pathFor('job-sensitive')
    const tracePath = join(root(), 'main.trace.ndjson')
    const workloadCanary = 'arbitrary-workload-output-do-not-bundle'
    writeFileSync(jobPath, `${JSON.stringify({ output: workloadCanary })}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    writeFileSync(
      tracePath,
      `${JSON.stringify({ type: 'ordinary-diagnostic', message: 'keep-me' })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )

    const bundle = collectBundle({
      traceFilePath: tracePath,
      maxFiles: 2,
      daemonLogFilePath: jobPath,
      daemonLogMaxFiles: 2,
      appVersion: 'test',
      platform: 'test',
      arch: 'test',
      osRelease: 'test',
      devboxChannel: 'dev'
    })

    expect(bundle.payload).toContain('keep-me')
    expect(bundle.payload).not.toContain(workloadCanary)
    expect(bundle.spanCount).toBe(1)
  })
})
