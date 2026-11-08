import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxPreflightResult } from '../core/devbox-preflight'
import type { ConnectWorkspaceInput, InitWorkspaceInput, MutagenDaemonProbe, MutagenDaemonServiceState, MutagenLogsResult, MutagenServiceActionResult, MutagenSessionActionResult, MutagenSetupResult, MutagenSpokesResult, MutagenStatusResult, WorkspaceBootstrapResult } from './hub-types'
import type { MutagenCli } from '../sync/mutagen-cli'
import type { DevboxProfileSshTarget } from './profile-ssh'
import type { MutagenDaemonService, ServiceExec } from './mutagen-service'
import * as mutagenService from './mutagen-service'
import { DevboxHubOperations, type DevboxHubOperationsDeps } from './operations-hub'
import { DevboxService, type DevboxHubServiceAdapter } from './operations'
import { syncLockPath, tryAcquireSyncLock } from './sync-now-lock'
import { existsSync } from 'node:fs'

const profile = {
  id: 'workspace',
  roots: { localRoot: '/tmp/local', remoteRoot: '/home/dev/workspace' },
  sshTarget: { identity: { host: '203.0.113.10', port: 22, username: 'dev', hostKeyFingerprint: 'SHA256:test' } }
} as unknown as DevboxProfileV1
const target = {
  profile,
  endpoint: { host: '203.0.113.10', port: 22, username: 'dev' },
  ssh: { command: async () => '', script: async () => '' }
} as unknown as DevboxProfileSshTarget

const state = (overrides: Partial<MutagenDaemonServiceState> = {}): MutagenDaemonServiceState => ({
  platform: 'linux', manager: 'systemd-user', label: 'devbox-mutagen-daemon.service', unitPath: '/tmp/unit', wrapperPath: '/tmp/wrapper', logPath: '/tmp/log', installed: true, loaded: true, running: true, pid: 42, ...overrides
})
const probe = (overrides: Partial<MutagenDaemonProbe> = {}): MutagenDaemonProbe => ({
  running: false, pid: null, origin: 'none', binaryPath: '/tmp/mutagen', version: '0.18.1', dataDirectory: '/tmp/state/mutagen', lastCycleAt: null, ...overrides
})
const hub = (reachable = true) => ({
  reachable, hubId: 'hub-id', root: profile.roots.remoteRoot, host: '203.0.113.10', port: 22, user: 'dev', registered: reachable, record: null, spokes: [], thisSpokeId: 'spoke', liveAgentCount: 0, rootState: reachable ? 'exists-empty' as const : 'unknown' as const, isSpokeRoot: false
})

function service(overrides: Partial<MutagenDaemonService> = {}): MutagenDaemonService {
  const current = state()
  return {
    describe: async () => current,
    install: async () => ({ state: current, action: 'installed' as const }),
    uninstall: vi.fn(async () => current),
    start: vi.fn(async () => current),
    stop: vi.fn(async () => current),
    restart: vi.fn(async () => current),
    readLog: async () => ({ logPath: current.logPath, exists: false, lines: [] }),
    ...overrides
  }
}

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function base(overrides: Partial<DevboxHubOperationsDeps> = {}): Promise<DevboxHubOperationsDeps> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'devbox-hub-'))
  cleanup.push(stateRoot)
  return {
    stateRoot,
    profileRoot: join(stateRoot, 'profiles'),
    env: { HOME: stateRoot, TMPDIR: join(stateRoot, 'tmp') },
    home: stateRoot,
    platform: 'linux',
    devboxVersion: '0.3.0',
    daemonService: service(),
    resolveBinary: async () => '/tmp/mutagen',
    loadProfile: () => profile,
    sshTarget: () => target,
    createMutagen: async () => ({ listSessions: async () => [], flush: async () => undefined, pause: async () => undefined, resume: async () => undefined } as unknown as MutagenCli),
    pair: async () => ({ state: 'paired', sessions: 1 }),
    preflight: async () => ({ status: 'ready', blockers: [], checks: [] } as unknown as DevboxPreflightResult),
    createProfile: async () => { throw new Error('unused') },
    useProfile: () => ({}),
    configuredDefaultProfile: () => undefined,
    setProfileEnvFile: async () => ({}),
    setProfileShellDir: async () => ({}),
    sleep: async () => undefined,
    ...overrides
  }
}

function sequence(values: readonly MutagenDaemonProbe[]): () => Promise<MutagenDaemonProbe> {
  let index = 0
  return async () => values[Math.min(index++, values.length - 1)]!
}

describe('DevboxHubOperations', () => {
  it('hands an on-demand daemon to the installed service and stops it first', async () => {
    const calls: string[][] = []
    const exec: ServiceExec = async (_command, args) => { calls.push([...args]); return { exitCode: 0, stdout: '', stderr: '' } }
    const restart = vi.fn(async () => state({ pid: 99, running: true }))
    const deps = await base({ exec, daemonService: service({ install: async () => ({ state: state({ pid: 99 }), action: 'installed' as const }), restart }) })
    deps.probe = sequence([probe({ running: true, origin: 'on-demand', pid: 7 }), probe({ running: true, origin: 'service', pid: 99 }), probe({ running: true, origin: 'service', pid: 99 })])

    const result = await new DevboxHubOperations(deps).mutagenSetup(undefined, { remote: false, service: true })

    expect(restart).toHaveBeenCalledTimes(1)
    expect(calls).toContainEqual(['daemon', 'stop'])
    expect(result.daemon.origin).toBe('service')
  })

  it('falls back to daemon start if service ownership never arrives', async () => {
    const calls: string[][] = []
    const exec: ServiceExec = async (_command, args) => { calls.push([...args]); return { exitCode: 0, stdout: '', stderr: '' } }
    const deps = await base({ exec })
    deps.probe = async () => probe({ running: true, origin: 'on-demand', pid: 7 })

    const result = await new DevboxHubOperations(deps).mutagenSetup(undefined, { remote: false, service: true })

    expect(calls).toContainEqual(['daemon', 'stop'])
    expect(calls).toContainEqual(['daemon', 'start'])
    expect(result.hints.join(' ')).toContain('started on demand')
  })

  it('skips binary resolution and installation when service=false', async () => {
    const resolveBinary = vi.fn(async () => '/tmp/mutagen')
    const install = vi.fn(async () => ({ state: state(), action: 'installed' as const }))
    const deps = await base({ resolveBinary, daemonService: service({ install }) })

    const result = await new DevboxHubOperations(deps).mutagenSetup(undefined, { remote: false, service: false })

    expect(result.service.action).toBe('skipped')
    expect(resolveBinary).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('returns an unreachable hub and keeps setup successful when registration fails', async () => {
    const deps = await base({
      registerHubAndSpoke: async () => { throw new Error('hub write denied') },
      readHub: async () => hub(false)
    })

    const result = await new DevboxHubOperations(deps).mutagenSetup('workspace', { remote: true, service: false })

    expect(result.hub).toMatchObject({ reachable: false, registered: false })
    expect(result.hints.join(' ')).toContain('hub write denied')
  })

  it('uses the service manager for start/restart/delete and kills on-demand daemons on stop', async () => {
    const runAction = async (action: 'start' | 'stop' | 'restart' | 'delete', probeValues: MutagenDaemonProbe[]) => {
      const calls: string[][] = []
      const exec: ServiceExec = async (_command, args) => { calls.push([...args]); return { exitCode: 0, stdout: '', stderr: '' } }
      const manager = service({ stop: vi.fn(async () => state({ running: false, pid: null })), uninstall: vi.fn(async () => state({ installed: false, running: false, pid: null })) })
      const deps = await base({ exec, daemonService: manager })
      deps.probe = sequence(probeValues)
      const result = await new DevboxHubOperations(deps).mutagenServiceAction(action)
      return { result, manager, calls }
    }

    const started = await runAction('start', [probe({ running: true, origin: 'service' }), probe({ running: true, origin: 'service' })])
    expect(started.result.via).toBe('systemd-user')
    expect(started.result.action).toBe('start')

    const stopped = await runAction('stop', [probe({ running: true, origin: 'on-demand', pid: 7 }), probe({ running: false }), probe({ running: false })])
    expect(stopped.result.via).toBe('systemd-user')
    expect(stopped.calls).toContainEqual(['daemon', 'stop'])

    const restarted = await runAction('restart', [probe({ running: true, origin: 'service' }), probe({ running: true, origin: 'service' })])
    expect(restarted.result.via).toBe('systemd-user')
    expect(restarted.result.action).toBe('restart')

    const deleted = await runAction('delete', [probe({ running: true, origin: 'service' })])
    expect(deleted.result.via).toBe('systemd-user')
    expect(deleted.result.detail).toBe('Keepalive service removed; sessions untouched. Sync-touching commands (status, sync, pair) start the daemon on demand; `devbox mutagen status` never does.')
  })

  it('makes mutagen restart wait for a running db sync (run lock) and leaves start unblocked', async () => {
    const exec: ServiceExec = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    const waits: string[] = []
    const deps = await base({ exec, daemonService: service() })
    const held = tryAcquireSyncLock({ path: syncLockPath(deps.stateRoot), pid: process.pid })
    if (!('handle' in held)) {throw new Error('lock should be free')}
    deps.onSyncLockWait = (action, holder) => {
      waits.push(`${action}:${holder.pid}`)
      held.handle.release()
    }
    deps.probe = sequence([probe({ running: true, origin: 'service' })])
    const operations = new DevboxHubOperations(deps)
    await operations.mutagenServiceAction('start')
    expect(waits).toEqual([])
    const restarted = await operations.mutagenServiceAction('restart')
    expect(restarted.action).toBe('restart')
    expect(waits).toEqual([`restart:${process.pid}`])
    expect(existsSync(syncLockPath(deps.stateRoot))).toBe(false)
  })

  it('passes the default executor through the production service wiring', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'devbox-production-wiring-'))
    cleanup.push(stateRoot)
    const calls: string[] = []
    const executor = vi.spyOn(mutagenService, 'defaultServiceExec').mockImplementation(async (command) => {
      calls.push(command)
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    try {
      const service = new DevboxService({ stateRoot, env: { HOME: stateRoot, DEVBOX_MUTAGEN_BINARY: join(stateRoot, 'mutagen') } })
      const result = await service.mutagenStatus(undefined, { remote: false })
      expect(result.daemon.origin).toBe('none')
      expect(calls).toContain('ps')
      await service.dispose()
    } finally {
      executor.mockRestore()
    }
  })

  it('stops the daemon gracefully before stopping or restarting its service', async () => {
    const events: string[] = []
    const exec: ServiceExec = async (_command, args) => {
      events.push(`mutagen:${args.join(' ')}`)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const manager = service({
      stop: vi.fn(async () => { events.push('service:stop'); return state({ running: false, pid: null }) }),
      restart: vi.fn(async () => { events.push('service:restart'); return state({ running: true, pid: 99 }) })
    })
    const deps = await base({ exec, daemonService: manager })
    deps.probe = sequence([
      probe({ running: true, origin: 'service', pid: 7 }),
      probe({ running: false }),
      probe({ running: true, origin: 'service', pid: 99 })
    ])
    const operations = new DevboxHubOperations(deps)
    await operations.mutagenServiceAction('stop')
    expect(events.slice(0, 2)).toEqual(['mutagen:daemon stop', 'service:stop'])

    events.length = 0
    deps.probe = sequence([
      probe({ running: true, origin: 'service', pid: 7 }),
      probe({ running: true, origin: 'service', pid: 99 }),
      probe({ running: true, origin: 'service', pid: 99 })
    ])
    const restarted = await operations.mutagenServiceAction('restart')
    expect(events.slice(0, 2)).toEqual(['mutagen:daemon stop', 'service:restart'])
    expect(restarted.detail).toMatch(/completed in \d+ms/u)
  })

  it('collects one result per session when an action fails', async () => {
    const pause = vi.fn(async (id: string) => { if (id === 'bad') {throw new Error('failed')} })
    const cli = { listSessions: async () => [{ identifier: 'ok', name: 'ok' }, { identifier: 'bad', name: 'bad' }], pause } as unknown as MutagenCli
    const deps = await base({ createMutagen: async () => cli })

    const result = await new DevboxHubOperations(deps).mutagenSessionAction('workspace', 'pause')

    expect(result.sessions).toEqual([{ identifier: 'ok', name: 'ok', ok: true }, { identifier: 'bad', name: 'bad', ok: false, error: 'failed' }])
    expect(pause).toHaveBeenCalledTimes(2)
  })

  it('constructs lazily and delegates every hub method through the test seam', async () => {
    const mutagenStatus = vi.fn(async () => ({} as MutagenStatusResult))
    const mutagenSetup = vi.fn(async () => ({} as MutagenSetupResult))
    const mutagenServiceAction = vi.fn(async () => ({} as MutagenServiceActionResult))
    const mutagenLogs = vi.fn(async () => ({} as MutagenLogsResult))
    const mutagenSessionAction = vi.fn(async () => ({} as MutagenSessionActionResult))
    const mutagenSpokes = vi.fn(async () => ({} as MutagenSpokesResult))
    const initWorkspace = vi.fn(async () => ({} as WorkspaceBootstrapResult))
    const connectWorkspace = vi.fn(async () => ({} as WorkspaceBootstrapResult))
    const adapter = { mutagenStatus, mutagenSetup, mutagenServiceAction, mutagenLogs, mutagenSessionAction, mutagenSpokes, initWorkspace, connectWorkspace } as unknown as DevboxHubServiceAdapter
    const factory = vi.fn(() => adapter)
    const service = new DevboxService({ env: { HOME: '/tmp' }, stateRoot: '/tmp/devbox-service-test', hubFactory: factory })

    expect(factory).not.toHaveBeenCalled()
    await service.mutagenStatus('p', { remote: false })
    await service.mutagenSetup('p', { remote: false, service: true })
    await service.mutagenServiceAction('start')
    await service.mutagenLogs(10)
    await service.mutagenSessionAction('p', 'pause')
    await service.mutagenSpokes('p')
    await service.initWorkspace({} as InitWorkspaceInput)
    await service.connectWorkspace({} as ConnectWorkspaceInput)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(mutagenStatus).toHaveBeenCalledWith('p', { remote: false })
    expect(mutagenSetup).toHaveBeenCalledWith('p', { remote: false, service: true })
    expect(mutagenServiceAction).toHaveBeenCalledWith('start')
    expect(mutagenLogs).toHaveBeenCalledWith(10)
    expect(mutagenSessionAction).toHaveBeenCalledWith('p', 'pause')
    expect(mutagenSpokes).toHaveBeenCalledWith('p')
    expect(initWorkspace).toHaveBeenCalled()
    expect(connectWorkspace).toHaveBeenCalled()
    await service.dispose()
  })
})
