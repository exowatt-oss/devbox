import { describe, expect, it } from 'vitest'
import type { DevboxOperationEnvelope } from '../../shared/devbox-types'
import type { DevboxAuthorityEpoch, DevboxAuthorityEpochRecord } from '../../shared/devbox-types'
import type {
  DevboxOperationJournal,
  DevboxOperationJournalRecord
} from '../devbox-operation-journal'
import type { DevboxPathMapper, DevboxPathMappingResult } from '../devbox-path-mapper'
import type { DevboxAuthorityEpochManager } from './devbox-authority-epoch'
import {
  createDevboxAuthorityError,
  type DevboxAuthorityEpochCheck
} from './devbox-authority-witness'
import {
  DevboxSessionPolicy,
  type DevboxPhiProcessEvidence,
  type DevboxSessionProcessInventory
} from './devbox-session-policy'

const SESSION_PATH = '/local/.phi/sessions/session.jsonl'
const FORK_PATH = '/remote/.phi/sessions/session.jsonl'
const VALID_JSONL = '{"role":"user","text":"hello"}\n'
const EPOCH: DevboxAuthorityEpochRecord = {
  epoch: 'epoch-1' as DevboxAuthorityEpoch,
  sequence: 1,
  owner: 'local',
  observedAt: 1,
  committedAt: 1
}

const emptyInventory = (): DevboxSessionProcessInventory => ({
  status: 'complete',
  processes: [],
  managedJobs: []
})

function process(overrides: Partial<DevboxPhiProcessEvidence>): DevboxPhiProcessEvidence {
  return {
    pid: 42,
    command: 'phi --resume',
    ownership: 'unmanaged',
    phi: 'confirmed',
    ...overrides
  }
}

function fixture(
  input: {
    changed?: boolean
    inventories?: readonly DevboxSessionProcessInventory[]
    reads?: readonly string[]
    accepted?: boolean
  } = {}
) {
  const phases: DevboxOperationEnvelope['phase'][] = []
  const archives: { sourcePath: string; archivePath: string; content: string }[] = []
  const forks: { sourcePath: string; forkPath: string; content: string }[] = []
  const inventories = input.inventories ?? [emptyInventory(), emptyInventory()]
  const reads = input.reads ?? [VALID_JSONL, VALID_JSONL]
  let inventoryIndex = 0
  let readIndex = 0
  const journal: Pick<DevboxOperationJournal, 'append'> = {
    append(operation) {
      phases.push(operation.phase)
      const record: DevboxOperationJournalRecord = {
        schemaVersion: 1,
        recordId: `${operation.operationId}:record`,
        sequence: phases.length,
        operation,
        checksum: 'test'
      }
      return { status: 'written', record }
    }
  }
  const authority: Pick<DevboxAuthorityEpochManager, 'validateEpoch'> = {
    validateEpoch: (): DevboxAuthorityEpochCheck =>
      input.accepted === false
        ? {
            status: 'rejected',
            error: createDevboxAuthorityError(
              'stale_epoch',
              'The supplied authority epoch is stale.',
              false
            )
          }
        : { status: 'accepted', epoch: EPOCH }
  }
  const mapped = (
    sourcePath: string,
    direction: 'local-to-remote' | 'remote-to-local'
  ): DevboxPathMappingResult => ({
    status: 'mapped',
    sourcePath,
    mappedPath: FORK_PATH,
    direction,
    syncClassId: 'session-durable'
  })
  const pathMapper: Pick<DevboxPathMapper, 'map' | 'unmap'> = {
    map: (sourcePath) => mapped(sourcePath, 'local-to-remote'),
    unmap: (sourcePath) => mapped(sourcePath, 'remote-to-local')
  }
  const filesystem = {
    readJsonl: async () => {
      const value = reads[Math.min(readIndex++, reads.length - 1)]
      return value ?? VALID_JSONL
    },
    archive: async (value: (typeof archives)[number]) => {
      archives.push(value)
    },
    fork: async (value: (typeof forks)[number]) => {
      forks.push(value)
    }
  }
  const processes = {
    inspect: async () => {
      const value = inventories[Math.min(inventoryIndex++, inventories.length - 1)]
      return value ?? emptyInventory()
    }
  }
  const policy = new DevboxSessionPolicy({
    journal,
    authority,
    pathMapper,
    discovery: {
      discover: async () => [{ sessionPath: SESSION_PATH, changed: input.changed ?? true }]
    },
    processes,
    filesystem,
    clock: { now: () => 0, sleep: async () => undefined },
    observation: { maxSamples: 2 }
  })
  return { policy, phases, archives, forks, inventories }
}

function request(targetOwner: 'local' | 'remote' = 'remote') {
  return {
    operationId: 'session-operation',
    idempotencyKey: 'session-operation-key',
    sessionPath: SESSION_PATH,
    authorityEpoch: EPOCH,
    targetOwner
  }
}

describe('DevboxSessionPolicy', () => {
  it('blocks a managed Phi process with path, PID evidence, and remediation', async () => {
    const { policy, archives } = fixture({
      inventories: [
        { status: 'complete', processes: [process({ ownership: 'managed' })], managedJobs: [] }
      ]
    })

    const result = await policy.archiveChanged(request())

    expect(result).toMatchObject({ status: 'blocked', error: { code: 'writer_not_acknowledged' } })
    if (result.status !== 'blocked') {
      throw new Error('Expected a blocked result.')
    }
    expect(result.error.message).toContain(SESSION_PATH)
    expect(result.error.message).toContain('Stop or reattach Phi')
    expect(result.error.evidence?.processEvidence).toContain('42')
    expect(archives).toHaveLength(0)
  })

  it('treats unknown inspection and unmanaged Phi as present', async () => {
    const unknown = fixture({
      inventories: [
        { status: 'unknown', processes: [], managedJobs: [], reason: 'host probe timed out' }
      ]
    })
    const unknownResult = await unknown.policy.archiveChanged(request())
    expect(unknownResult).toMatchObject({
      status: 'blocked',
      error: { code: 'transition_blocked' }
    })

    const unmanaged = fixture({
      inventories: [{ status: 'complete', processes: [process({})], managedJobs: [] }]
    })
    const unmanagedResult = await unmanaged.policy.archiveChanged(request())
    expect(unmanagedResult).toMatchObject({
      status: 'blocked',
      error: { code: 'writer_not_acknowledged' }
    })

    const managedJob = fixture({
      inventories: [
        {
          status: 'complete',
          processes: [],
          managedJobs: [{ jobId: 'phi-job', kind: 'phi', state: 'running', phi: 'not-phi' }]
        }
      ]
    })
    const managedJobResult = await managedJob.policy.archiveChanged(request())
    expect(managedJobResult).toMatchObject({
      status: 'blocked',
      error: { code: 'writer_not_acknowledged' }
    })
  })

  it('requires valid stable JSONL before archiving', async () => {
    const invalid = fixture({ reads: ['not-json'] })
    const invalidResult = await invalid.policy.archiveChanged(request())
    expect(invalidResult).toMatchObject({
      status: 'blocked',
      error: { code: 'transition_blocked' }
    })
    expect(invalid.archives).toHaveLength(0)

    const changing = fixture({
      reads: [VALID_JSONL, '{"role":"assistant"}\n', '{"role":"tool"}\n']
    })
    const changingResult = await changing.policy.archiveChanged(request())
    expect(changingResult).toMatchObject({ status: 'blocked', error: { code: 'external_drift' } })
    expect(changing.archives).toHaveLength(0)
  })

  it('archives only after two absent inventories and journals every handoff phase', async () => {
    const { policy, archives, phases } = fixture()

    const result = await policy.archiveChanged(request())

    expect(result).toMatchObject({ status: 'archived', archivePath: FORK_PATH })
    expect(archives).toEqual([
      { sourcePath: SESSION_PATH, archivePath: FORK_PATH, content: VALID_JSONL }
    ])
    expect(phases).toEqual([
      'preparing',
      'quiescing',
      'checkpointing',
      'reconciling',
      'committing-epoch',
      'verifying',
      'resuming',
      'completed'
    ])
  })

  it('blocks when a writer appears during the final inventory', async () => {
    const { policy, archives } = fixture({
      inventories: [
        emptyInventory(),
        { status: 'complete', processes: [process({})], managedJobs: [] }
      ]
    })

    const result = await policy.archiveChanged(request())

    expect(result).toMatchObject({ status: 'blocked', error: { code: 'writer_not_acknowledged' } })
    expect(archives).toHaveLength(0)
  })

  it('keeps an active off-authority session on its authority and never forks it', async () => {
    const active = fixture({
      inventories: [{ status: 'complete', processes: [process({})], managedJobs: [] }]
    })

    const result = await active.policy.open(request('remote'))

    expect(result).toMatchObject({ status: 'blocked', error: { code: 'writer_not_acknowledged' } })
    expect(active.forks).toHaveLength(0)
  })

  it('forks a closed session to the mapped side without writing the source', async () => {
    const closed = fixture()

    const result = await closed.policy.open(request('remote'))

    expect(result).toMatchObject({ status: 'forked', forkPath: FORK_PATH })
    expect(closed.forks).toEqual([
      { sourcePath: SESSION_PATH, forkPath: FORK_PATH, content: VALID_JSONL }
    ])
    expect(closed.archives).toHaveLength(0)
  })

  it('attaches on authority without making an active JSONL dual-writable', async () => {
    const active = fixture({
      inventories: [{ status: 'complete', processes: [process({})], managedJobs: [] }]
    })

    const result = await active.policy.open(request('local'))

    expect(result).toMatchObject({ status: 'attached', sessionPath: SESSION_PATH })
    expect(active.forks).toHaveLength(0)
    expect(active.archives).toHaveLength(0)
  })

  it('rejects a stale epoch before discovery or filesystem access', async () => {
    const stale = fixture({ accepted: false })

    const result = await stale.policy.open(request('remote'))

    expect(result).toMatchObject({ status: 'blocked', error: { code: 'stale_epoch' } })
    if (result.status !== 'blocked') {
      throw new Error('Expected a blocked result.')
    }
    expect(result.error.message).toContain(SESSION_PATH)
    expect(stale.forks).toHaveLength(0)
    expect(stale.archives).toHaveLength(0)
  })
})
