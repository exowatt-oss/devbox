import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevboxAuthorityEpoch, DevboxOperationEnvelope } from '../../shared/devbox-types'

export type FaultRootFixture = {
  root: string
  sourceRoot: string
  generationsRoot: string
}

export async function createFaultRoot(prefix: string): Promise<FaultRootFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const sourceRoot = join(root, 'live')
  const generationsRoot = join(root, 'generations')
  await mkdir(join(sourceRoot, 'src'), { recursive: true, mode: 0o700 })
  await writeFile(join(sourceRoot, 'src', 'main.ts'), 'export const value = 1\n')
  await writeFile(join(sourceRoot, 'README.md'), 'fault fixture\n')
  return { root, sourceRoot, generationsRoot }
}

export async function removeFaultRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

export function operation(operationId: string, sequence: number = 1): DevboxOperationEnvelope {
  return {
    operationId,
    kind: 'sync',
    phase: 'ready',
    idempotencyKey: `fault:${operationId}`,
    cancellation: { requested: false },
    timestamps: { startedAt: sequence, updatedAt: sequence },
    authorityEpoch: {
      epoch: `fault-epoch-${sequence}` as DevboxAuthorityEpoch,
      sequence,
      owner: 'remote',
      observedAt: sequence,
      committedAt: sequence
    },
    status: {
      execution: { side: 'remote', state: 'running' },
      authority: { side: 'remote', state: 'owner' },
      freshness: { state: 'fresh', observedAt: sequence },
      conflict: { state: 'none' },
      drift: { state: 'none' },
      connectivity: { state: 'online' },
      auth: { state: 'healthy' },
      disk: { state: 'healthy', freeBytes: 1024 }
    }
  }
}

export class InjectedFault extends Error {
  constructor(readonly point: string) {
    super(`Injected fault at ${point}.`)
    this.name = 'InjectedFault'
  }
}
