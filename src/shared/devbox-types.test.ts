import { describe, expect, it } from 'vitest'
import {
  isMonotonicDevboxAuthorityEpoch,
  type DevboxAuthorityEpochRecord
} from './devbox-types'

describe('Devbox profile contract', () => {
  it('requires monotonic opaque authority epochs and never models expiry', () => {
    const previous: DevboxAuthorityEpochRecord = {
      epoch: 'opaque-a' as DevboxAuthorityEpochRecord['epoch'],
      sequence: 1,
      owner: 'local',
      observedAt: 10,
      committedAt: 11
    }
    const next: DevboxAuthorityEpochRecord = {
      epoch: 'opaque-b' as DevboxAuthorityEpochRecord['epoch'],
      sequence: 2,
      owner: 'remote',
      observedAt: 12,
      committedAt: 13
    }
    expect(isMonotonicDevboxAuthorityEpoch(previous, next)).toBe(true)
    expect(isMonotonicDevboxAuthorityEpoch(next, previous)).toBe(false)
    expect(next).not.toHaveProperty('expiresAt')
  })
})
