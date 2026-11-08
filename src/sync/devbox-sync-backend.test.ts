import { describe, expect, it } from 'vitest'
import {
  assertDevboxSyncConflictResolutionRequest,
  conflictMatchesExpectedHashes,
  DEVBOX_SYNC_EXCLUSIONS,
  isDevboxSyncSessionOwnedByProfile,
  type DevboxSyncConflict,
  type DevboxSyncConflictResolutionRequest,
  type DevboxSyncSessionIdentity
} from './devbox-sync-backend'

const backupHandle = {
  id: 'backup-1',
  conflictId: 'conflict-1',
  localHash: 'local-hash',
  remoteHash: 'remote-hash',
  createdAt: 1
} as const

const conflict: DevboxSyncConflict = {
  conflictId: 'conflict-1',
  path: 'src/index.ts',
  local: { kind: 'file', hash: 'local-hash', size: 10 },
  remote: { kind: 'file', hash: 'remote-hash', size: 11 },
  class: 'content'
}

const session = (profileId: string, sessionId: string): DevboxSyncSessionIdentity => ({
  profileId,
  sessionId,
  rootClassId: 'working',
  backend: 'rsync-fallback',
  name: `devbox-${sessionId}`,
  labels: {
    'devbox-profile': profileId,
    'devbox-session': sessionId,
    'devbox-root-class': 'working',
    'devbox-backend': 'rsync-fallback'
  }
})

function expectOperationConflict(action: () => void): void {
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: 'operation_conflict' })
    return
  }
  throw new Error('expected operation_conflict')
}

describe('DevboxSyncBackend contract', () => {
  it('keeps the canonical lean filter and all protected state classes in one set', () => {
    expect(DEVBOX_SYNC_EXCLUSIONS).toEqual(
      expect.arrayContaining([
        '.git/',
        '.pi/agent/sessions/',
        '.pi/agent/secrets.env',
        'node_modules/',
        'dist/',
        '.local/state/',
        '*.db'
      ])
    )
  })

  it('rejects resolution without explicit expected hashes, backup, or winner', () => {
    const valid: DevboxSyncConflictResolutionRequest = {
      conflictId: conflict.conflictId,
      expectedLocalHash: conflict.local.hash,
      expectedRemoteHash: conflict.remote.hash,
      backupHandle,
      winner: 'local'
    }

    expectOperationConflict(() =>
      assertDevboxSyncConflictResolutionRequest({
        ...valid,
        expectedLocalHash: undefined
      })
    )
    expectOperationConflict(() =>
      assertDevboxSyncConflictResolutionRequest({
        ...valid,
        backupHandle: undefined
      })
    )
    expectOperationConflict(() =>
      assertDevboxSyncConflictResolutionRequest({
        ...valid,
        winner: undefined
      })
    )
  })

  it('requires both identities to remain unchanged before an explicit resolution', () => {
    expect(
      conflictMatchesExpectedHashes(conflict, {
        expectedLocalHash: 'local-hash',
        expectedRemoteHash: 'remote-hash'
      })
    ).toBe(true)
    expect(
      conflictMatchesExpectedHashes(conflict, {
        expectedLocalHash: 'new-local-hash',
        expectedRemoteHash: 'remote-hash'
      })
    ).toBe(false)
  })

  it('only recognizes sessions carrying every app-owned profile label', () => {
    const own = session('profile-1', 'session-1')
    const foreign = session('profile-2', 'session-2')
    const mislabeled = {
      ...own,
      labels: { ...own.labels, 'devbox-profile': 'profile-2' }
    }

    expect(isDevboxSyncSessionOwnedByProfile(own, 'profile-1', 'rsync-fallback')).toBe(true)
    expect(isDevboxSyncSessionOwnedByProfile(foreign, 'profile-1', 'rsync-fallback')).toBe(false)
    expect(isDevboxSyncSessionOwnedByProfile(mislabeled, 'profile-1', 'rsync-fallback')).toBe(false)
  })
})
