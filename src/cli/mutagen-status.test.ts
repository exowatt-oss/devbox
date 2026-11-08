import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxProfileSshTarget } from './profile-ssh'
import type { MutagenDaemonProbe, MutagenDaemonServiceState, MutagenSessionView } from './hub-types'
import type { MutagenDaemonService } from './mutagen-service'
import { assembleMutagenStatus } from './mutagen-status'

const roots = { localRoot: '/tmp/devbox-local', remoteRoot: '/home/devbox/workspace' }
const profile = {
  id: 'workspace',
  roots,
  sshTarget: { identity: { host: '203.0.113.10', port: 22, username: 'devbox', hostKeyFingerprint: 'SHA256:test' } }
} as unknown as DevboxProfileV1
const target = {
  profile,
  endpoint: { host: '203.0.113.10', port: 22, username: 'devbox' },
  ssh: { command: async () => '', script: async () => '' }
} as unknown as DevboxProfileSshTarget

const state = (overrides: Partial<MutagenDaemonServiceState> = {}): MutagenDaemonServiceState => ({
  platform: 'linux', manager: 'systemd-user', label: 'devbox-mutagen-daemon.service', unitPath: '/tmp/unit', wrapperPath: '/tmp/wrapper', logPath: '/tmp/log', installed: false, loaded: false, running: false, pid: null, ...overrides
})

const daemon = (overrides: Partial<MutagenDaemonProbe> = {}): MutagenDaemonProbe => ({
  running: false, pid: null, origin: 'none', binaryPath: '/tmp/mutagen', version: '0.18.1', dataDirectory: '/tmp/state/mutagen', lastCycleAt: null, ...overrides
})

const session = (overrides: Partial<MutagenSessionView> = {}): MutagenSessionView => ({
  identifier: 'session', name: 'session', labels: { 'devbox-backend': 'mutagen', 'devbox-profile': 'workspace' }, profileId: 'workspace', rootClass: 'portable-working', status: 'watching', paused: false, successfulCycles: 1, conflictCount: 0, problemCount: 0, lastError: null,
  alpha: { protocol: 'local', host: null, user: null, port: null, path: roots.localRoot, connected: true },
  beta: { protocol: 'ssh', host: '203.0.113.10', user: 'devbox', port: null, path: roots.remoteRoot, connected: true }, topology: 'spoke-to-hub', ...overrides
})

const hub = (overrides: Record<string, unknown> = {}) => ({
  reachable: true, hubId: 'hub-id', root: roots.remoteRoot, host: '203.0.113.10', port: 22, user: 'devbox', registered: true, record: null, spokes: [], thisSpokeId: 'spoke', liveAgentCount: 0, rootState: 'unknown' as const, isSpokeRoot: false, ...overrides
})

const services: MutagenDaemonService = {
  describe: async () => state(),
  install: async () => ({ state: state({ installed: true }), action: 'installed' as const }),
  uninstall: async () => state(),
  start: async () => state({ installed: true, running: true }),
  stop: async () => state(),
  restart: async () => state({ installed: true, running: true }),
  readLog: async () => ({ logPath: '/tmp/log', exists: false, lines: [] })
}

const rootsToClean: string[] = []
afterEach(async () => {
  await Promise.all(rootsToClean.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function deps(overrides: Partial<Parameters<typeof assembleMutagenStatus>[0]> = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'devbox-status-'))
  rootsToClean.push(stateRoot)
  return {
    stateRoot,
    env: { HOME: stateRoot, TMPDIR: join(stateRoot, 'tmp') },
    home: stateRoot,
    platform: 'linux' as const,
    daemonService: services,
    resolveBinary: async () => '/tmp/mutagen',
    probe: async () => daemon(),
    listSessions: async () => ({ available: true, sessions: [] }),
    loadProfile: () => profile,
    sshTarget: () => target,
    ...overrides
  }
}

describe('assembleMutagenStatus', () => {
  it('reports an unknown daemon when the process probe cannot run', async () => {
    const result = await assembleMutagenStatus(await deps({
      probe: undefined,
      exec: async (command) => command === 'ps' ? { exitCode: 127, stdout: '', stderr: 'ps unavailable' } : { exitCode: 0, stdout: '', stderr: '' }
    }), undefined, { remote: false })
    expect(result.daemon).toMatchObject({ running: false, origin: 'unknown' })
    expect(result.hints.join(' ')).toContain('Unable to determine')
  })

  it('covers missing service, installed-down, on-demand, and unavailable-session hints', async () => {
    const missing = await assembleMutagenStatus(await deps({ daemonService: { ...services, describe: async () => state() }, listSessions: async () => ({ available: false, sessions: [], detail: 'sync list failed' }) }), undefined, { remote: false })
    expect(missing.hints[0]).toContain('devbox mutagen setup')
    expect(missing.hints.join(' ')).toContain('sync list failed')

    const down = await assembleMutagenStatus(await deps({ daemonService: { ...services, describe: async () => state({ installed: true }) } }), undefined, { remote: false })
    expect(down.hints[0]).toContain('installed but no daemon')

    const onDemand = await assembleMutagenStatus(await deps({ daemonService: { ...services, describe: async () => state({ installed: true }) }, probe: async () => daemon({ running: true, origin: 'on-demand', pid: 4 }) }), undefined, { remote: false })
    expect(onDemand.hints[0]).toContain('hands it over')

    const unavailableBinary = await assembleMutagenStatus(await deps({ resolveBinary: async () => { throw new Error('Mutagen is not installed') } }), undefined, { remote: false })
    expect(unavailableBinary.binary.path).toBeNull()
    expect(unavailableBinary.hints.join(' ')).toContain('Mutagen is not installed')
  })

  it('reports violations, conflicts, and hub registration states in priority order', async () => {
    const violation = await assembleMutagenStatus(await deps({ listSessions: async () => ({ available: true, sessions: [session({ topology: 'violation', topologyDetail: 'local ↔ local is forbidden' })] }) }), undefined, { remote: false })
    expect(violation.topology.verdict).toBe('violation')
    expect(violation.hints.join(' ')).toContain('local ↔ local')

    let remoteReads = 0
    const unreachable = await assembleMutagenStatus(await deps({ loadProfile: () => profile, touchSpoke: async () => { remoteReads += 1; return hub({ reachable: false, registered: false, detail: 'SSH timeout' }) } }), 'workspace', { remote: true })
    expect(remoteReads).toBe(1)
    expect(unreachable.hub?.reachable).toBe(false)
    expect(unreachable.hints.join(' ')).toContain('SSH timeout')

    const unregistered = await assembleMutagenStatus(await deps({ touchSpoke: async () => hub({ registered: false }) }), 'workspace', { remote: true })
    expect(unregistered.hints.join(' ')).toContain('Register this spoke')

    const conflicts = await assembleMutagenStatus(await deps({ listSessions: async () => ({ available: true, sessions: [session({ conflictCount: 2 }), session({ conflictCount: 1 })] }) }), undefined, { remote: false })
    expect(conflicts.hints.join(' ')).toContain('3 conflict(s)')
    expect(conflicts.hints.join(' ')).toContain('docs/devbox-recovery.md §4')
  })

  it('warns about a Devbox session running outside db sync, but not while a db sync holds the lock', async () => {
    const sessions = async () => ({ available: true, sessions: [session(), session({ identifier: 'paused', paused: true })] })
    const stray = await assembleMutagenStatus(await deps({ listSessions: sessions }), undefined, { remote: false })
    expect(stray.hints.join(' ')).toContain('1 Devbox session(s) running outside `db sync`')
    const syncing = await assembleMutagenStatus(await deps({ listSessions: sessions, syncRunning: () => true }), undefined, { remote: false })
    expect(syncing.hints.join(' ')).not.toContain('running outside')
    const allPaused = await assembleMutagenStatus(await deps({ listSessions: async () => ({ available: true, sessions: [session({ paused: true })] }) }), undefined, { remote: false })
    expect(allPaused.hints.join(' ')).not.toContain('running outside')
  })

  it('hands the profile paste/credential roots to the session topology check', async () => {
    const listSessions = vi.fn(async () => ({ available: true, sessions: [] }))
    const withAux = {
      ...profile,
      pasteSync: { enabled: true, roots: [{ id: 'clipboard', localRoot: '/tmp/T', remoteRoot: '/tmp/T', patterns: ['terminal-paste-*'] }] },
      credentialSync: { enabled: true, roots: [{ id: 'mcp-auth', localRoot: '/tmp/home/.mcp-auth', remoteRoot: '/home/devbox/.mcp-auth', excludes: [] }] }
    } as unknown as DevboxProfileV1
    await assembleMutagenStatus(await deps({ loadProfile: () => withAux, listSessions }), 'workspace', { remote: false })
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({
      hub: {
        host: '203.0.113.10', user: 'devbox', ...roots,
        auxiliaryRoots: [
          { rootClass: 'paste', localRoot: '/tmp/T', remoteRoot: '/tmp/T' },
          { rootClass: 'credentials', localRoot: '/tmp/home/.mcp-auth', remoteRoot: '/home/devbox/.mcp-auth' }
        ]
      }
    }))
  })

  it('never touches the hub registry for no-remote or an absent profile', async () => {
    const touchSpoke = vi.fn(async () => hub())
    const readHub = vi.fn(async () => hub())
    const noRemote = await assembleMutagenStatus(await deps({ touchSpoke, readHub }), 'workspace', { remote: false })
    const noProfile = await assembleMutagenStatus(await deps({ touchSpoke, readHub }), undefined, { remote: true })
    expect(noRemote.hub).toBeNull()
    expect(noProfile.hub).toBeNull()
    expect(touchSpoke).not.toHaveBeenCalled()
    expect(readHub).not.toHaveBeenCalled()
  })

  it('turns an injected SSH exception into an unreachable hub instead of throwing', async () => {
    const result = await assembleMutagenStatus(await deps({ touchSpoke: async () => { throw new Error('connection refused') } }), 'workspace', { remote: true })
    expect(result.hub).toMatchObject({ reachable: false, registered: false, detail: 'connection refused' })
  })
})
