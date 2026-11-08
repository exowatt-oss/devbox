import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  DevboxAuthorityWitness,
  isDevboxAuthorityWitnessRecord,
  type DevboxAuthorityWitnessObservation
} from './devbox-authority-witness'
import type { DevboxAuthorityEpoch, DevboxAuthorityEpochRecord } from '../../shared/devbox-types'

const profileId = 'witness-test'
const epoch: DevboxAuthorityEpochRecord = {
  epoch: 'epoch-0' as DevboxAuthorityEpoch,
  sequence: 0,
  owner: 'local',
  observedAt: 1,
  committedAt: 1
}

function input(transitionId: string): DevboxAuthorityWitnessObservation {
  return {
    transitionId,
    stage: 'committed',
    previousEpoch: epoch,
    candidateEpoch: epoch,
    effectiveEpoch: epoch,
    stateFingerprint: 'fingerprint',
    updatedAt: 1
  }
}

describe('DevboxAuthorityWitness', () => {
  it('writes a checksummed host-local record and reloads it', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-witness-'))
    const path = join(root, 'host-local.json')
    const witness = new DevboxAuthorityWitness({
      profileId,
      kind: 'host-local',
      path
    })

    const written = witness.observe(input('transition-1'))
    const reloaded = new DevboxAuthorityWitness({
      profileId,
      kind: 'host-local',
      path
    })

    expect(isDevboxAuthorityWitnessRecord(written)).toBe(true)
    expect(reloaded.read()).toMatchObject({ status: 'valid', record: written })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      witnessId: 'host-local:witness-test',
      kind: 'host-local'
    })
  })

  it('detects checksum corruption instead of trusting the record', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-witness-corrupt-'))
    const path = join(root, 'peer.json')
    const witness = new DevboxAuthorityWitness({
      profileId,
      kind: 'peer-observed',
      path
    })
    witness.observe(input('transition-1'))
    const record = JSON.parse(readFileSync(path, 'utf8')) as { checksum: string }
    record.checksum = '0'.repeat(64)
    writeFileSync(path, `${JSON.stringify(record)}\n`)

    expect(witness.read()).toEqual({ status: 'corrupt', reason: 'invalid-record' })
  })

  it('keeps local and peer witness identities independent', () => {
    const local = new DevboxAuthorityWitness({ profileId, kind: 'host-local' })
    const peer = new DevboxAuthorityWitness({ profileId, kind: 'peer-observed' })
    const localRecord = local.observe(input('same-transition'))

    expect(peer.read()).toEqual({ status: 'missing' })
    expect(localRecord.witnessId).not.toBe(peer.witnessId)
    expect(() => peer.write(localRecord)).toThrow('identity mismatch')
  })
})
