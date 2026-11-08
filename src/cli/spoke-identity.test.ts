import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hubIdForRoot,
  listSpokeRoots,
  loadOrCreateSpokeIdentity,
  recordSpokeRoot
} from './spoke-identity'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('spoke identity', () => {
  it('creates a private stable identity and repairs corrupt JSON', () => {
    const root = makeTempRoot()
    const identity = loadOrCreateSpokeIdentity(root)
    expect(identity.schemaVersion).toBe(1)
    expect(identity.spokeId).toMatch(/^[0-9a-f]{12}$/)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(loadOrCreateSpokeIdentity(root)).toEqual(identity)
    expect(statSync(join(root, 'spoke.json')).mode & 0o777).toBe(0o600)
    writeFileSync(join(root, 'spoke.json'), '{bad json', 'utf8')
    const repaired = loadOrCreateSpokeIdentity(root)
    expect(repaired.spokeId).not.toBe(identity.spokeId)
    expect(loadOrCreateSpokeIdentity(root)).toEqual(repaired)
    expect(JSON.parse(readFileSync(join(root, 'spoke.json'), 'utf8'))).toEqual(repaired)
  })

  it('records sorted and deduplicated spoke roots', () => {
    const root = makeTempRoot()
    expect(recordSpokeRoot(root, '/workspace/z')).toEqual(['/workspace/z'])
    expect(recordSpokeRoot(root, '/workspace/a')).toEqual(['/workspace/a', '/workspace/z'])
    expect(recordSpokeRoot(root, '/workspace/z')).toEqual(['/workspace/a', '/workspace/z'])
    expect(recordSpokeRoot(root, '/workspace/A')).toEqual(['/workspace/A', '/workspace/a', '/workspace/z'])
    expect(listSpokeRoots(root)).toEqual(['/workspace/A', '/workspace/a', '/workspace/z'])
    writeFileSync(join(root, 'spoke-roots.json'), '{bad json', 'utf8')
    expect(recordSpokeRoot(root, '/workspace/b')).toEqual(['/workspace/b'])
    expect(statSync(join(root, 'spoke-roots.json')).mode & 0o777).toBe(0o600)
  })

  it('derives a deterministic twelve-character hub id', () => {
    const first = hubIdForRoot('/srv/devbox/workspace')
    expect(first).toMatch(/^[0-9a-f]{12}$/)
    expect(hubIdForRoot('/srv/devbox/workspace')).toBe(first)
    expect(hubIdForRoot('/srv/devbox/other')).not.toBe(first)
  })
})

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devbox-spoke-test-'))
  temporaryRoots.push(root)
  return root
}
