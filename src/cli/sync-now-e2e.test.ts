import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOME, PROFILES, REAL_SESSIONS } from './__fixtures__/sync-now-fixture'
import { FakeMutagen } from './__fixtures__/sync-now-fake-mutagen'
import type { HandlerContext } from './handlers'
import type { DevboxServiceLike } from './operations'
import { profileSshEndpoint } from './profile-ssh'
import { runSyncNow, type SyncNowDeps } from './sync-now'
import { SyncMutagenError } from './sync-now-mutagen'
import { createSyncNowHandler } from './sync-now-handler'
import { createSyncHooks } from './sync-now-hooks'
import { createSyncNowRenderer } from './sync-now-render'

/**
 * Hang drills end to end: real handler, engine, and plain renderer over a fake Mutagen
 * daemon. One machine hangs mid-flush with its link down, one never finishes scanning;
 * the command must skip both, sync the third, and return promptly with exit 0.
 */
afterEach(() => {
  process.exitCode = undefined
})

function drill(mutagen: FakeMutagen, flags: Record<string, string | boolean>, engine: { busyNoteMs?: number } = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const deps: SyncNowDeps = {
    mutagen,
    profiles: () => PROFILES,
    endpointFor: (profile) => profileSshEndpoint(profile),
    isLocal: () => false,
    home: HOME,
    reach: async () => ({ ok: true }),
    hooks: createSyncHooks({ stateRoot: '/nonexistent-devbox-state', env: process.env }),
    acquireLock: async () => ({ release: () => undefined }),
    startDaemon: async () => undefined
  }
  const service = {
    syncNow: (options, listener, signal) => runSyncNow({ ...options, stallGraceMs: 60, pollIntervalMs: 5, ...engine }, deps, listener, signal)
  } as Pick<DevboxServiceLike, 'syncNow'> as DevboxServiceLike
  const handler = createSyncNowHandler({
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text), isTTY: false },
    onInterrupt: () => () => undefined,
    hardExit: vi.fn(),
    createRenderer: createSyncNowRenderer
  })
  const context: HandlerContext = { flags: new Map(Object.entries(flags)), service, cwd: '/', json: false, presentation: { env: {}, isTTY: false, columns: 100 } }
  return { run: () => handler(context), stdout, stderr }
}

describe('db sync hang drills (handler → engine → renderer, fake Mutagen)', () => {
  it('skips a machine whose link dies mid-flush and one that outlives --timeout, syncs the rest, exits 0', async () => {
    const mutagen = new FakeMutagen(REAL_SESSIONS)
    // workstation: the flush hangs and its credentials endpoint drops (a box that froze mid-sync).
    // aws: connected but its flush never returns (scanning forever) -> only the cap ends it.
    mutagen.flushBehaviour = (ids) => ids.includes('sync_project_decl') || ids.includes('sync_devbox_decl') ? 'hang' : { ok: true }
    mutagen.onList = (fake) => {
      if (fake.log.some((entry) => entry.startsWith('flush:sync_project')) && !fake.paused('sync_roam_creds')) {fake.set('sync_roam_creds', { status: 'connecting-beta', connected: false })}
    }
    mutagen.resumedState = (id) => id.startsWith('sync_devbox') ? { status: 'scanning', connected: true } : { status: 'watching', connected: true }
    const { run, stdout, stderr } = drill(mutagen, { timeout: '1' })
    const started = Date.now()
    await run()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(process.exitCode).toBe(0)
    const summary = stdout.join('')
    expect(summary).toMatch(/○ workstation .*skipped · stalled \(no connection for \d+ ms\)/u)
    // The timeout detail remains visible, inline or on a following line depending on column width.
    expect(summary).toMatch(/○ aws .*skipped · timeout/u)
    expect(summary).toContain('still syncing at the 1 s --timeout cap')
    expect(summary).toMatch(/✓ macmini .*synced/u)
    expect(summary).toContain('1 synced · 2 skipped')
    expect(stderr.join('')).toContain('workstation  skipped: stalled')
    for (const id of ['sync_project_decl', 'sync_roam_creds', 'sync_devbox_decl', 'sync_phi']) {expect(mutagen.paused(id)).toBe(true)}
  })

  it('keeps every machine waiting through a silent Mutagen daemon and skips it only at the --timeout cap', async () => {
    const mutagen = new FakeMutagen(REAL_SESSIONS)
    mutagen.flushBehaviour = () => {
      mutagen.listFailures = 1_000_000
      return 'hang'
    }
    const { run, stdout, stderr } = drill(mutagen, { timeout: '1' }, { busyNoteMs: 50 })
    const started = Date.now()
    await run()
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(Date.now() - started).toBeLessThan(5_000)
    const out = stdout.join('')
    expect(out).toContain('3 skipped')
    expect(stderr.join('')).toContain('Mutagen busy · no status for')
    expect(out).toMatch(/skipped · timeout/u)
    expect(out).not.toContain('stalled')
    expect(process.exitCode).toBe(0)
  })

  it('skips (never fails) a machine whose resume hit an ssh connection timeout and never connects, exits 0', async () => {
    const mutagen = new FakeMutagen(REAL_SESSIONS)
    const stderrText = 'Error: unable to resume session: unable to connect to beta: unable to dial agent endpoint: (\nConnection to UNKNOWN port 65535 timed out)\n'
    mutagen.resumeError = (ids) => ids.includes('sync_phi') ? new SyncMutagenError('Connection to UNKNOWN port 65535 timed out', false, stderrText) : undefined
    mutagen.resumedState = (id) => id === 'sync_phi' || id.startsWith('sync_devbox') ? { status: 'connecting-beta', connected: false } : { status: 'watching', connected: true }
    const { run, stdout, stderr } = drill(mutagen, { device: 'aws', plain: true })
    await run()
    expect(process.exitCode).toBe(0)
    const summary = stdout.join('')
    expect(summary).toMatch(/○ aws .*skipped · unreachable/u)
    expect(summary).toContain('Connection to UNKNOWN port 65535 timed out')
    expect(summary).not.toContain('failed')
    expect(stderr.join('')).toMatch(/aws +skipped: unreachable \(Connection to UNKNOWN port 65535 timed out\)/u)
    for (const id of ['sync_devbox_decl', 'sync_devbox_work', 'sync_phi']) {expect(mutagen.paused(id)).toBe(true)}
  })

  it('shows a small lane that finished its own flush as synced when the big lane on the same machine hits the cap', async () => {
    const mutagen = new FakeMutagen(REAL_SESSIONS)
    mutagen.flushDelayFor = (id) => id.startsWith('sync_devbox') ? 5_000 : 5
    const { run, stdout } = drill(mutagen, { device: 'aws', plain: true, timeout: '1' })
    await run()
    expect(process.exitCode).toBe(0)
    const summary = stdout.join('')
    expect(summary).toMatch(/○ aws .*skipped · timeout/u)
    expect(summary).toMatch(/ {4}workspace +~\/project +skipped\n/u)
    expect(summary).toMatch(/ {4}phi sessions +~\/.* +synced/u)
    for (const id of ['sync_devbox_decl', 'sync_devbox_work', 'sync_phi']) {expect(mutagen.paused(id)).toBe(true)}
  })
})
