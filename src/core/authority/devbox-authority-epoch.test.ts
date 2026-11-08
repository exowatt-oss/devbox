import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  DevboxAuthorityCrash,
  DevboxAuthorityEpochManager,
  type DevboxAuthorityAcquisition,
  type DevboxAuthorityEpochManagerOptions,
  type DevboxAuthorityQuiesceAck,
  type DevboxAuthorityTransitionStage
} from './devbox-authority-epoch'
import { DevboxAuthorityWitness } from './devbox-authority-witness'
import { DevboxOperationJournal } from '../devbox-operation-journal'
import type { DevboxAuthorityEpoch, DevboxAuthorityEpochRecord } from '../../shared/devbox-types'

const profileId = 'authority-test'
const initialEpoch: DevboxAuthorityEpochRecord = {
  epoch: 'epoch-0' as DevboxAuthorityEpoch,
  sequence: 0,
  owner: 'local',
  observedAt: 1,
  committedAt: 1
}

function fixture(options: Partial<DevboxAuthorityEpochManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devbox-authority-'))
  const journal = new DevboxOperationJournal({
    journalPath: join(root, 'operations.jsonl')
  })
  const local = new DevboxAuthorityWitness({ profileId, kind: 'host-local' })
  const peer = new DevboxAuthorityWitness({ profileId, kind: 'peer-observed' })
  const manager = new DevboxAuthorityEpochManager({
    profileId,
    journal,
    witnesses: [local, peer],
    initialEpoch,
    epochFactory: (sequence) => `epoch-${sequence}` as DevboxAuthorityEpoch,
    ...options
  })
  return { root, journal, local, peer, manager }
}

function acquire(
  manager: DevboxAuthorityEpochManager,
  targetOwner: 'local' | 'remote',
  operationId: string
): DevboxAuthorityAcquisition {
  const result = manager.acquire({
    targetOwner,
    operationId,
    idempotencyKey: `authority:${profileId}:${operationId}`
  })
  if (result.status !== 'acquired') {
    throw new Error(`Expected acquisition, got ${result.status}.`)
  }
  return result
}

async function commit(
  manager: DevboxAuthorityEpochManager,
  acquisition: DevboxAuthorityAcquisition
): Promise<void> {
  const result = await manager.commit(acquisition)
  expect(result.status).toBe('committed')
}

function observation(epoch: DevboxAuthorityEpochRecord, transitionId: string, ownerEpoch = epoch) {
  return {
    transitionId,
    stage: 'committed' as const,
    previousEpoch: epoch,
    candidateEpoch: ownerEpoch,
    effectiveEpoch: ownerEpoch,
    stateFingerprint: 'stable',
    updatedAt: epoch.committedAt
  }
}

describe('DevboxAuthorityEpochManager', () => {
  it('advances epochs strictly and rejects a stale holder', async () => {
    const { manager } = fixture()
    const first = acquire(manager, 'remote', 'handoff-1')
    await commit(manager, first)
    const second = acquire(manager, 'local', 'handoff-2')
    await commit(manager, second)

    expect(first.candidateEpoch.sequence).toBe(1)
    expect(second.candidateEpoch.sequence).toBe(2)
    expect(manager.currentEpoch()).toEqual(second.candidateEpoch)
    expect(manager.validateEpoch(initialEpoch)).toMatchObject({
      status: 'rejected',
      error: { code: 'stale_epoch' }
    })
  })

  it('halts before writing when the independent witnesses disagree', () => {
    const { manager, local, peer } = fixture()
    const remoteEpoch: DevboxAuthorityEpochRecord = {
      ...initialEpoch,
      epoch: 'peer-epoch' as DevboxAuthorityEpoch,
      owner: 'remote'
    }
    const localBefore = local.observe(observation(initialEpoch, 'seed-local'))
    peer.observe(observation(initialEpoch, 'seed-peer', remoteEpoch))

    const result = manager.acquire({ targetOwner: 'remote', operationId: 'split' })

    expect(result).toMatchObject({ status: 'blocked', error: { code: 'split_authority' } })
    expect(local.read()).toMatchObject({ status: 'valid', record: localBefore })
    expect(manager.currentEpoch()).toBeNull()
  })

  it('names a managed writer that does not acknowledge quiescing', async () => {
    const { manager } = fixture({ quiesceTimeoutMs: 5 })
    const never = new Promise<DevboxAuthorityQuiesceAck>(() => undefined)
    manager.registerWriter({
      writerId: 'sync-supervisor-culprit',
      kind: 'sync-supervisor',
      epoch: initialEpoch.epoch,
      quiesce: () => never
    })
    const acquisition = acquire(manager, 'remote', 'writer-timeout')

    const result = await manager.commit(acquisition)

    expect(result).toMatchObject({
      status: 'blocked',
      epoch: initialEpoch,
      error: {
        code: 'writer_not_acknowledged',
        culprit: 'sync-supervisor-culprit'
      }
    })
    expect(manager.currentEpoch()).toEqual(initialEpoch)
  })

  it('reports external drift with both observed fingerprints', async () => {
    let observations = 0
    const { manager } = fixture({
      stateFingerprint: () => {
        observations += 1
        return observations < 3 ? 'fingerprint-a' : 'fingerprint-b'
      }
    })
    const acquisition = acquire(manager, 'remote', 'drift')

    const result = await manager.commit(acquisition)

    expect(result).toMatchObject({
      status: 'blocked',
      error: {
        code: 'external_drift',
        evidence: {
          baselineFingerprint: 'fingerprint-a',
          observedFingerprint: 'fingerprint-b'
        }
      }
    })
    expect(manager.currentEpoch()).toEqual(initialEpoch)
  })

  it('replays every crash stage to one committed or rolled-back outcome', async () => {
    const stages: readonly DevboxAuthorityTransitionStage[] = [
      'prepare',
      'quiesce',
      'checkpoint',
      'reconcile',
      'verify',
      'commit-epoch',
      'resume'
    ]
    for (const stage of stages) {
      const { manager, journal, local, peer } = fixture()
      let acquisition: DevboxAuthorityAcquisition
      if (stage === 'prepare') {
        expect(() =>
          manager.acquire({ targetOwner: 'remote', operationId: stage, crashAt: stage })
        ).toThrow(DevboxAuthorityCrash)
      } else {
        acquisition = acquire(manager, 'remote', stage)
        await expect(manager.commit(acquisition, stage)).rejects.toBeInstanceOf(
          DevboxAuthorityCrash
        )
      }
      const recovered = new DevboxAuthorityEpochManager({
        profileId,
        journal,
        witnesses: [local, peer],
        initialEpoch,
        epochFactory: (sequence) => `epoch-${sequence}` as DevboxAuthorityEpoch
      }).recover()
      const committed = stage === 'commit-epoch' || stage === 'resume'
      expect(recovered.status).toBe(committed ? 'committed' : 'rolled-back')
      const current = new DevboxAuthorityEpochManager({
        profileId,
        journal,
        witnesses: [local, peer],
        initialEpoch
      }).currentEpoch()
      expect(current?.owner).toBe(committed ? 'remote' : 'local')
    }
  })

  it('makes a committed transition replay as a verified no-op', async () => {
    const { manager } = fixture()
    const acquisition = acquire(manager, 'remote', 'replay')
    await commit(manager, acquisition)

    const replay = await manager.commit(acquisition)
    const acquireReplay = manager.acquire({
      targetOwner: 'remote',
      operationId: 'replay',
      idempotencyKey: acquisition.idempotencyKey
    })

    expect(replay).toMatchObject({ status: 'replayed', epoch: acquisition.candidateEpoch })
    expect(acquireReplay).toMatchObject({
      status: 'replayed',
      epoch: acquisition.candidateEpoch
    })
  })

  it('does not expire an epoch when the clock advances', async () => {
    let now = 10
    const { manager } = fixture({ now: () => now })
    const acquisition = acquire(manager, 'remote', 'no-expiry')
    await commit(manager, acquisition)
    now = 9_999_999

    expect(manager.currentEpoch()).toEqual(acquisition.candidateEpoch)
    expect(acquisition.candidateEpoch).not.toHaveProperty('expiresAt')
  })
})
