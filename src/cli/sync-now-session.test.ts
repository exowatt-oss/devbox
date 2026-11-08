import { describe, expect, it } from 'vitest'
import { REAL_SESSIONS, sessionJson } from './__fixtures__/sync-now-fixture'
import { isDisconnected, laneProgressOf, machinePhaseOf, parseSyncSessions, sessionPhase, type SyncSessionSnapshot } from './sync-now-session'

function snapshot(overrides: Record<string, unknown> = {}, alpha: Record<string, unknown> = {}, beta: Record<string, unknown> = {}): SyncSessionSnapshot {
  const base = sessionJson({ id: 's1', profile: 'p', rootClass: 'portable-working', local: '/l', user: 'u', host: 'h', remote: '/r', paused: false, status: 'watching' })
  const merged = { ...base, ...overrides, alpha: { ...base.alpha as object, ...alpha }, beta: { ...base.beta as object, ...beta } }
  return parseSyncSessions(JSON.stringify([merged]))[0]!
}

describe('db sync Mutagen session snapshots', () => {
  it('parses the real `sync list` JSON shape, defaulting omitted zero values', () => {
    const sessions = parseSyncSessions(JSON.stringify(REAL_SESSIONS))
    expect(sessions).toHaveLength(11)
    const first = sessions[0]!
    expect(first).toMatchObject({ id: 'sync_project_decl', status: 'disconnected', paused: true, successfulCycles: 0, conflicts: 0 })
    expect(first.beta).toMatchObject({ protocol: 'ssh', user: 'sample', host: '203.0.113.10', connected: false, scanned: false, problems: 0 })
    expect(first.beta.port).toBeUndefined()
    expect(first.labels['devbox-root-class']).toBe('portable-declarative')
    const macmini = sessions.find((session) => session.id === 'sync_macmini_decl')!
    expect(macmini).toMatchObject({ paused: false, status: 'scanning' })
    expect(macmini.alpha.connected).toBe(true)
  })

  it('accepts newline-delimited JSON and skips entries without an identifier', () => {
    const rows = [JSON.stringify(REAL_SESSIONS[0]), JSON.stringify({ status: 'watching' })].join('\n')
    expect(parseSyncSessions(rows).map((session) => session.id)).toEqual(['sync_project_decl'])
    expect(parseSyncSessions('  ')).toEqual([])
  })

  it('counts conflicts and problems including the truncated (excluded) counts', () => {
    const session = snapshot(
      { conflicts: [{}, {}], excludedConflicts: 3, lastError: 'boom', successfulCycles: 4 },
      { scanProblems: [{ path: 'a' }], excludedScanProblems: 2, files: 120, scanned: true },
      { transitionProblems: [{ path: 'b' }], excludedTransitionProblems: 1 }
    )
    expect(session).toMatchObject({ conflicts: 5, lastError: 'boom', successfulCycles: 4 })
    expect(session.alpha).toMatchObject({ problems: 3, files: 120, scanned: true })
    expect(session.beta.problems).toBe(2)
  })

  it('maps Mutagen 0.18 statuses to phases', () => {
    const phase = (status: string, flushed = false) => sessionPhase(snapshot({ status }), flushed)
    expect(phase('disconnected')).toBe('connecting')
    expect(phase('connecting-alpha')).toBe('connecting')
    expect(phase('connecting-beta')).toBe('connecting')
    expect(phase('scanning')).toBe('scanning')
    expect(phase('waiting-for-rescan')).toBe('scanning')
    expect(phase('reconciling')).toBe('reconciling')
    expect(phase('staging-alpha')).toBe('transferring')
    expect(phase('staging-beta')).toBe('transferring')
    expect(phase('transitioning')).toBe('transferring')
    expect(phase('saving')).toBe('saving')
    expect(phase('halted-on-root-emptied')).toBe('failed')
    expect(phase('watching')).toBe('scanning')
    expect(phase('watching', true)).toBe('synced')
    // Once its flush completed a session stays synced: a later change-triggered cycle is not this run's work.
    expect(phase('scanning', true)).toBe('synced')
    expect(phase('halted-on-root-emptied', true)).toBe('failed')
  })

  it('folds a lane: least-advanced phase, summed staging, largest file/conflict/problem count', () => {
    const scanning = snapshot({ identifier: 'a', status: 'scanning' }, { files: 10, scanned: true })
    const staging = snapshot({ identifier: 'b', status: 'staging-beta', lastError: 'transient' }, { files: 5, scanned: true }, { stagingProgress: { path: 'x/y', receivedFiles: 2, expectedFiles: 9, receivedSize: 10, expectedSize: 20, totalReceivedSize: 300 } })
    expect(laneProgressOf([scanning, staging])).toEqual({ phase: 'scanning', mutagenStatus: 'scanning', files: 10, conflicts: 0, problems: 0, lastError: 'transient' })
    // portable-declarative + portable-working mirror one root: 615,890 files, not 1,231,780.
    const declarative = snapshot({ identifier: 'd', status: 'scanning', conflicts: [{}], excludedConflicts: 41 }, { files: 615_890, scanned: true, scanProblems: [{}, {}] })
    const working = snapshot({ identifier: 'w', status: 'scanning', conflicts: [{}], excludedConflicts: 41 }, { files: 615_890, scanned: true, scanProblems: [{}, {}] })
    expect(laneProgressOf([declarative, working])).toMatchObject({ files: 615_890, conflicts: 42, problems: 2 })
    const both = laneProgressOf([staging, snapshot({ identifier: 'c', status: 'staging-alpha' }, { stagingProgress: { receivedFiles: 1, expectedFiles: 1, totalReceivedSize: 50 } })])
    expect(both).toMatchObject({ phase: 'transferring', staging: { receivedFiles: 3, expectedFiles: 10, receivedBytes: 350, path: 'x/y' } })
    expect(both.staging?.expectedBytes).toBeUndefined()
    const done = laneProgressOf([snapshot({ identifier: 'a', status: 'scanning' })], new Set(['a']))
    expect(done.phase).toBe('synced')
    expect(laneProgressOf([]).phase).toBe('connecting')
  })

  it('reports disconnection and the least-advanced unfinished machine phase', () => {
    expect(isDisconnected(snapshot({ status: 'connecting-beta' }))).toBe(true)
    expect(isDisconnected(snapshot({ status: 'scanning' }, {}, { connected: false }))).toBe(true)
    expect(isDisconnected(snapshot({ status: 'scanning' }))).toBe(false)
    expect(isDisconnected(snapshot({ status: 'halted-on-root-deletion' }, { connected: false }))).toBe(false)
    expect(machinePhaseOf(['synced', 'transferring', 'scanning'])).toBe('scanning')
    expect(machinePhaseOf(['synced', 'synced'])).toBeUndefined()
    expect(machinePhaseOf(['failed', 'saving'])).toBe('saving')
  })
})
