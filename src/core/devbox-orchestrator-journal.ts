import { randomUUID } from 'node:crypto'
import type { DevboxAuthorityEpochRecord, DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxOperationJournal } from './devbox-operation-journal'
import type { DevboxOrchestratorStatus } from './devbox-orchestrator-types'

function epoch(owner: 'local' | 'remote', now: number): DevboxAuthorityEpochRecord {
  return {
    epoch: randomUUID() as DevboxAuthorityEpochRecord['epoch'],
    sequence: 0,
    owner,
    observedAt: now,
    committedAt: now
  }
}

export function appendDevboxOperation(
  journal: DevboxOperationJournal,
  profile: DevboxProfileV1 | null,
  status: DevboxOrchestratorStatus,
  phase: 'preparing' | 'quiescing' | 'ready',
  kind: 'pair' | 'disable',
  now: number
): string {
  const operationId = status.operationId ?? randomUUID()
  const result = journal.append(
    {
      operationId,
      kind,
      phase,
      idempotencyKey: operationId,
      cancellation: { requested: false },
      timestamps: { startedAt: now, updatedAt: now },
      authorityEpoch: epoch(profile?.defaultAuthority ?? 'local', now),
      status: {
        execution: { side: 'none', state: 'idle' },
        authority: { side: profile?.defaultAuthority ?? 'local', state: 'owner' },
        freshness: { state: 'unknown' },
        conflict: { state: 'none' },
        drift: { state: 'none' },
        connectivity: { state: 'online' },
        auth: { state: 'unknown' },
        disk: { state: 'unknown' }
      }
    },
    { recordId: randomUUID() }
  )
  if (result.status !== 'written') {
    throw result.error
  }
  return operationId
}
