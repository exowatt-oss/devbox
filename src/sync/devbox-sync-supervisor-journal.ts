import { randomUUID } from 'node:crypto'
import type { DevboxAuthorityEpoch, DevboxOperationEnvelope } from '../shared/devbox-types'
import { operationStatus } from './devbox-sync-supervisor-status'
import type { SupervisorRuntime } from './devbox-sync-supervisor-runtime'

export function record(runtime: SupervisorRuntime, phase: string): void {
  if (!runtime.journal) {
    return
  }
  const now = runtime.now()
  const operation: DevboxOperationEnvelope = {
    operationId: `sync-supervisor:${runtime.profileId}`,
    kind: 'sync',
    phase: phase as DevboxOperationEnvelope['phase'],
    idempotencyKey: `sync-supervisor:${runtime.profileId}`,
    cancellation: { requested: false },
    timestamps: { startedAt: now, updatedAt: now },
    authorityEpoch: {
      epoch: `sync:${runtime.profileId}` as DevboxAuthorityEpoch,
      sequence: 1,
      owner: 'remote',
      observedAt: now,
      committedAt: now
    },
    status: operationStatus()
  }
  const result = runtime.journal.append(operation, { recordId: randomUUID() })
  if (result.status !== 'written') {
    throw result.error
  }
}
