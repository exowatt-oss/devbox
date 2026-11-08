import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { DevboxPathMapper } from '../../core/devbox-path-mapper'
import { DevboxPreflight, type DevboxExec, type DevboxExecResult } from '../../core/devbox-preflight'
import { collectDevboxTrackedFiles } from '../../core/devbox-rsync-tracked'
import { createEntryTree, createWorktreeShapedRepos } from './generated-trees'
import { createScaleRoots, scaleProfile } from './fixture-profile'

const identity = {
  host: 'scale-fixture.invalid',
  port: 22,
  username: 'fixture',
  hostKeyFingerprint: 'SHA256:scale-fixture'
}

const result = (stdout = '', entries?: DevboxExecResult['entries']): DevboxExecResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  ...(entries ? { entries } : {})
})

function preflightFakes(
  localRoot: string,
  remoteRoot: string,
  remoteEntries: DevboxExecResult['entries'],
  localEntries: DevboxExecResult['entries'] = [
    { path: `${localRoot}/local-sentinel.txt`, kind: 'file' }
  ]
): { local: DevboxExec; remote: DevboxExec } {
  const remote: DevboxExec = async (request) => {
    if (request.command === 'printf') {
      return { ...result('devbox-preflight-reachable'), identity }
    }
    if (request.command === 'cat') {
      return result('ID=ubuntu\nVERSION_ID="22.04"\n')
    }
    if (request.command === 'uname') {
      return result('x86_64')
    }
    if (request.command === 'sudo') {
      return result()
    }
    if (request.command === 'systemctl') {
      return result('running')
    }
    if (request.command === 'loginctl') {
      return result('yes')
    }
    if (request.command === 'bash' && request.args[0] === '--version') {
      return result('GNU bash')
    }
    if (request.command === 'bash') {
      return result('unlimited\n4096\n')
    }
    if (request.command === 'python3' && request.args[0] === '--version') {
      return result('Python 3.12')
    }
    if (request.command === 'python3') {
      return result('', remoteEntries)
    }
    if (request.command === 'df' && request.args.includes('--output=avail')) {
      return result('90000000000\n')
    }
    if (request.command === 'df') {
      return result('1000000\n')
    }
    if (request.command === 'rsync' && request.args[0] === '--version') {
      return result('rsync version 3.2.7\nCompression: zstd')
    }
    if (request.command === 'rsync') {
      return result()
    }
    throw new Error(`unexpected remote command ${request.command}`)
  }
  const local: DevboxExec = async (request) => {
    if (request.command === 'python3') {
      return result('', localEntries)
    }
    throw new Error(`unexpected local command ${request.command}`)
  }
  void remoteRoot
  return { local, remote }
}

describe('Devbox generated scale fixtures', () => {
  it('maps a generated 100k-entry tree without quadratic collision scanning', async () => {
    const fixture = await createScaleRoots('devbox-scale-map-')
    try {
      const paths = await createEntryTree(fixture.local, 100_000)
      const mapper = new DevboxPathMapper(scaleProfile(fixture.local, fixture.remote))
      const rssBefore = process.memoryUsage().rss
      const started = performance.now()
      const mapped = paths.map((path) => mapper.map(path))
      const elapsedMs = performance.now() - started
      const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024)
      const successful = mapped.filter((item) => item.status === 'mapped')

      console.info(
        `scale fixture: mapped=${successful.length} entries=${paths.length} ` +
          `elapsedMs=${elapsedMs.toFixed(1)} rssDeltaMb=${rssDeltaMb.toFixed(1)}`
      )
      expect(paths).toHaveLength(100_000)
      expect(successful).toHaveLength(100_000)
      expect(elapsedMs).toBeLessThan(15_000)
      expect(rssDeltaMb).toBeLessThan(200)
    } finally {
      await fixture.cleanup()
    }
  }, 90_000)

  it('runs preflight against a generated 100k-entry remote inventory', async () => {
    const fixture = await createScaleRoots('devbox-scale-preflight-')
    try {
      const paths = await createEntryTree(fixture.remote, 100_000)
      const remoteEntries = paths.map((path) => ({ path, kind: 'file' as const }))
      const profile = scaleProfile(fixture.local, fixture.remote)
      const fakes = preflightFakes(fixture.local, fixture.remote, remoteEntries)
      const preflight = new DevboxPreflight(profile, {
        localExec: fakes.local,
        remoteExec: fakes.remote,
        clock: Date.now
      })
      const rssBefore = process.memoryUsage().rss
      const started = performance.now()
      const assessment = await preflight.run({
        operationId: 'scale-preflight',
        capacity: {
          leanSeedBytes: 0,
          trackedRestoreBytes: 0,
          syncStagingBytes: 0,
          runtimeGenerationBytes: 0,
          consistentWorkspaceBytes: 0,
          blockReserveBytes: 0,
          inodeReserve: 0
        }
      })
      const elapsedMs = performance.now() - started
      const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024)

      console.info(
        `scale fixture: preflightRemoteEntries=${remoteEntries.length} ` +
          `pathIssues=${assessment.pathIssues.length} elapsedMs=${elapsedMs.toFixed(1)} ` +
          `rssDeltaMb=${rssDeltaMb.toFixed(1)}`
      )
      expect(assessment.status).toBe('ready')
      expect(assessment.pathIssues).toHaveLength(0)
      expect(elapsedMs).toBeLessThan(15_000)
      expect(rssDeltaMb).toBeLessThan(200)
    } finally {
      await fixture.cleanup()
    }
  }, 90_000)

  it('keeps local preflight path checks subquadratic as inventory grows', async () => {
    const fixture = await createScaleRoots('devbox-scale-local-preflight-')
    try {
      const paths = await createEntryTree(fixture.local, 2_000)
      const localEntries = paths.map((path) => ({ path, kind: 'file' as const }))
      const profile = scaleProfile(fixture.local, fixture.remote)
      const fakes = preflightFakes(fixture.local, fixture.remote, [], localEntries)
      const preflight = new DevboxPreflight(profile, {
        localExec: fakes.local,
        remoteExec: fakes.remote,
        clock: Date.now
      })
      const started = performance.now()
      const assessment = await preflight.run({
        operationId: 'scale-local-preflight',
        capacity: {
          leanSeedBytes: 0,
          trackedRestoreBytes: 0,
          syncStagingBytes: 0,
          runtimeGenerationBytes: 0,
          consistentWorkspaceBytes: 0,
          blockReserveBytes: 0,
          inodeReserve: 0
        }
      })
      const elapsedMs = performance.now() - started

      console.info(
        `scale fixture: localPreflightEntries=${localEntries.length} ` +
          `status=${assessment.status} elapsedMs=${elapsedMs.toFixed(1)}`
      )
      expect(assessment.status).toBe('ready')
      expect(elapsedMs).toBeLessThan(500)
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  it('discovers 210 worktree-shaped repositories with one bounded git probe each', async () => {
    const fixture = await createScaleRoots('devbox-scale-worktrees-')
    try {
      const repositories = await createWorktreeShapedRepos(fixture.local, 210)
      const probes: string[] = []
      const started = performance.now()
      const tracked = await collectDevboxTrackedFiles(fixture.local, {
        exec: async (request) => {
          probes.push(request.args[1] ?? '')
          return {
            exitCode: 0,
            stdout: 'tracked.ts\0',
            stderr: ''
          }
        }
      })
      const elapsedMs = performance.now() - started

      console.info(
        `scale fixture: repositories=${repositories.length} gitProbes=${probes.length} tracked=${tracked.length} elapsedMs=${elapsedMs.toFixed(1)}`
      )
      expect(repositories).toHaveLength(210)
      expect(probes).toHaveLength(210)
      expect(tracked).toHaveLength(210)
      expect(new Set(tracked).size).toBe(210)
      expect(elapsedMs).toBeLessThan(10_000)
    } finally {
      await fixture.cleanup()
    }
  })
})
