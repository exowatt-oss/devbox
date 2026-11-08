import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevboxProfileV1 } from '../../shared/devbox-types'

export type DevboxScaleRoots = {
  root: string
  local: string
  remote: string
  outside: string
  cleanup: () => Promise<void>
}

export async function createScaleRoots(prefix: string): Promise<DevboxScaleRoots> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const local = join(root, 'local')
  const remote = join(root, 'remote')
  const outside = join(root, 'outside-secret')
  await Promise.all([mkdir(local, { recursive: true }), mkdir(remote, { recursive: true })])
  return {
    root,
    local,
    remote,
    outside,
    cleanup: () => rm(root, { force: true, recursive: true })
  }
}

export function scaleProfile(localRoot: string, remoteRoot: string): DevboxProfileV1 {
  return {
    schemaVersion: 1,
    id: 'scale-fixture',
    displayName: 'Scale fixture',
    sshTarget: {
      targetId: 'scale-fixture-target',
      identity: {
        host: 'scale-fixture.invalid',
        port: 22,
        username: 'fixture',
        hostKeyFingerprint: 'SHA256:scale-fixture'
      }
    },
    roots: { localRoot, remoteRoot },
    pathMap: [],
    toolchain: { lockId: 'scale-lock', lockSha256: 'a'.repeat(64) },
    sync: {
      classes: [
        {
          id: 'working',
          kind: 'portable-working',
          backend: 'rsync-fallback',
          mode: 'two-way-safe',
          excludes: []
        }
      ],
      defaultClassId: 'working',
      excludes: []
    },
    credentials: [],
    defaultAuthority: 'remote',
    projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
    featureDefaults: { detachedJobs: true, closedSessionHistory: true },
    slo: {
      syncLagTargetMs: 5_000,
      reconnectTargetMs: 15_000,
      operationRecoveryTargetMs: 30_000,
      offlineEdits: 'warn'
    }
  }
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)
  return sorted[Math.max(0, index)]!
}
