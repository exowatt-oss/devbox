import { describe, expect, it } from 'vitest'
import { checksumDevboxGitRoamingMarker, makeDevboxGitRoamingMarker, validateDevboxGitRoamingMarker, createFileGitRoamingMarkerStore } from './devbox-git-roaming-remote'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('git roaming marker', () => {
  it('round-trips and rejects checksum tampering', async () => {
    const marker = makeDevboxGitRoamingMarker({ schemaVersion: 1, profileId: 'fixture', epochSequence: 4, epoch: 'authority:fixture:4:remote:id', owner: 'remote', transitionId: 't1', stage: 'committed', manifestDigest: 'a'.repeat(64), updatedAt: 10 })
    expect(validateDevboxGitRoamingMarker(marker)).toBe(true)
    const { checksum: _checksum, ...unsigned } = marker
    void _checksum
    expect(checksumDevboxGitRoamingMarker(unsigned)).toBe(marker.checksum)
    const root = await mkdtemp(join(tmpdir(), 'devbox-marker-'))
    const store = createFileGitRoamingMarkerStore(join(root, 'peer-marker.json'))
    await store.write(marker)
    await expect(store.read()).resolves.toMatchObject({ epochSequence: 4, owner: 'remote' })
    const tampered = { ...marker, owner: 'local' as const }
    expect(validateDevboxGitRoamingMarker(tampered)).toBe(false)
  })
})
