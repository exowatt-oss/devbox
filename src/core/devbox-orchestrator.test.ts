import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DevboxProfileStore } from './devbox-profile-store'
import { DevboxOrchestrator } from './devbox-orchestrator'
import { devboxSyncRequests } from './devbox-orchestrator-actions'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'profile-1',
  displayName: 'Fixture',
  sshTarget: {
    targetId: 'target-1',
    identity: { host: 'fixture', port: 22, username: 'user', hostKeyFingerprint: 'SHA256:x' }
  },
  roots: { localRoot: '/local/project', remoteRoot: '/remote/project' },
  pathMap: [],
  toolchain: { lockId: 'lock-1', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [
      {
        id: 'working',
        kind: 'portable-working',
        backend: 'mutagen',
        mode: 'two-way-safe',
        excludes: []
      }
    ],
    defaultClassId: 'working',
    excludes: []
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 5_000,
    reconnectTargetMs: 15_000,
    operationRecoveryTargetMs: 30_000,
    offlineEdits: 'warn'
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'devbox-orchestrator-'))
}

function fakeSupervisor(counters: {
  starts: number
  stops: number
  active: number
  max: number
  events: string[]
}) {
  return {
    start: async () => {
      counters.starts++
      counters.active++
      counters.max = Math.max(counters.max, counters.active)
      return {
        profileId: 'profile-1',
        state: 'running' as const,
        sessions: [],
        capability: 'unavailable' as const,
        watchMode: 'None' as const,
        sloTarget: { label: 'none' as const, p95Ms: null, p99Ms: null },
        conflictCount: 0,
        backpressure: { bulkConcurrency: 1 as const, queuedOperations: 0 },
        observedAt: Date.now()
      }
    },
    shutdownForDisable: async () => {
      counters.events.push('flush', 'pause', 'verify')
      counters.stops++
      counters.active--
    }
  }
}

describe('DevboxOrchestrator', () => {
  it('creates sessions only for portable classes the path map or default class routes to', () => {
    const declarative = { id: 'portable-declarative', kind: 'portable-declarative' as const, backend: 'mutagen' as const, mode: 'two-way-safe' as const, excludes: [] }
    const twoClasses = { ...profile, sync: { ...profile.sync, classes: [...profile.sync.classes, declarative] } }
    // Both classes span the same root pair: an unrouted declarative class would be a duplicate session.
    expect(devboxSyncRequests(twoClasses).map((request) => request.rootClassId)).toEqual(['working'])
    const routed = { ...twoClasses, pathMap: [{ id: 'docs', localRelativePath: 'docs', remoteRelativePath: 'docs', syncClassId: 'portable-declarative' }] }
    expect(devboxSyncRequests(routed).map((request) => request.rootClassId)).toEqual(['working', 'portable-declarative'])
  })

  it('appends credential requests after unchanged portable requests', () => {
    const portableRequests = devboxSyncRequests(profile)
    const requests = devboxSyncRequests({
      ...profile,
      credentialSync: {
        enabled: true,
        roots: [
          {
            id: 'mcp-auth',
            localRoot: '/local/.mcp-auth',
            remoteRoot: '/remote/.mcp-auth',
            excludes: ['*_lock.json']
          }
        ]
      }
    })

    expect(requests.slice(0, portableRequests.length)).toEqual(portableRequests)
    expect(requests).toHaveLength(portableRequests.length + 1)
    expect(requests.at(-1)).toEqual({
      profileId: 'profile-1',
      sessionId: 'profile-1-credentials-mcp-auth',
      rootClassId: 'credentials',
      localRoot: '/local/.mcp-auth',
      remoteRoot: '/remote/.mcp-auth',
      mode: 'two-way-resolved',
      exclusionPolicy: 'explicit-only',
      maxEntryCount: 20_000,
      excludes: ['*_lock.json']
    })
  })

  it('appends one-way paste mirror requests after credential requests', () => {
    const portableRequests = devboxSyncRequests(profile)
    const requests = devboxSyncRequests({
      ...profile,
      credentialSync: {
        enabled: true,
        roots: [{ id: 'mcp-auth', localRoot: '/local/.mcp-auth', remoteRoot: '/remote/.mcp-auth', excludes: [] }]
      },
      pasteSync: {
        enabled: true,
        roots: [{
          id: 'clipboard',
          localRoot: '/tmp/devbox-temp/ab/cd/T',
          remoteRoot: '/tmp/devbox-temp/ab/cd/T',
          patterns: ['terminal-paste-*', 'remote-paste-*']
        }]
      }
    })

    expect(requests).toHaveLength(portableRequests.length + 2)
    expect(requests.at(-2)?.rootClassId).toBe('credentials')
    expect(requests.at(-1)).toEqual({
      profileId: 'profile-1',
      sessionId: 'profile-1-paste-clipboard',
      rootClassId: 'paste',
      localRoot: '/tmp/devbox-temp/ab/cd/T',
      remoteRoot: '/tmp/devbox-temp/ab/cd/T',
      mode: 'one-way-replica',
      exclusionPolicy: 'explicit-only',
      maxEntryCount: 50_000,
      excludes: ['*', '!terminal-paste-*', '!remote-paste-*']
    })
    expect(devboxSyncRequests({ ...profile, pasteSync: { enabled: false, roots: [] } })).toEqual(portableRequests)
  })

  it('propagates the profile watch polling override to every Mutagen request', () => {
    const requests = devboxSyncRequests({
      ...profile,
      sync: { ...profile.sync, watchPollingIntervalSeconds: 60 },
      credentialSync: {
        enabled: true,
        roots: [{ id: 'mcp-auth', localRoot: '/local/.mcp-auth', remoteRoot: '/remote/.mcp-auth', excludes: [] }]
      }
    })
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.watchPollingIntervalSeconds === 60)).toBe(true)
    expect(requests[0]).toMatchObject({ maxEntryCount: undefined, watchPollingIntervalSeconds: 60 })
    expect(requests[1]).toMatchObject({ maxEntryCount: 20_000, watchPollingIntervalSeconds: 60 })
  })

  it('forwards enabled job inspection, cancellation, and log tails', async () => {
    const statusResult = {
      id: 'job-1',
      specHash: 'hash-1',
      unitName: 'unit-1',
      cgroupPath: '/cgroup/job-1',
      status: 'running' as const
    }
    const tailResult = {
      jobId: 'job-1',
      offset: 10,
      nextOffset: 20,
      text: 'output',
      droppedMarkers: [],
      sensitive: true as const,
      includeInDiagnostics: false as const
    }
    const status = vi.fn(async () => statusResult)
    const cancel = vi.fn(async () => undefined)
    const tailLog = vi.fn(() => tailResult)
    const orchestrator = new DevboxOrchestrator({
      profileId: profile.id,
      profileStore: { loadProfile: vi.fn() } as never,
      journalRoot: root(),
      env: {},
      jobs: { status, cancel, tailLog } as never
    })

    await expect(orchestrator.jobStatus('job-1')).resolves.toBe(statusResult)
    await expect(orchestrator.cancelJob('job-1')).resolves.toBeUndefined()
    await expect(orchestrator.tailJobLog('job-1', 10, 100)).resolves.toBe(tailResult)
    expect(status).toHaveBeenCalledWith('job-1')
    expect(cancel).toHaveBeenCalledWith('job-1')
    expect(tailLog).toHaveBeenCalledWith('job-1', 10, 100)
  })

  it('serializes restart/reattach and bounds supervisors after repeated disable/start', async () => {
    const profileRoot = root()
    const store = new DevboxProfileStore({ rootDir: join(profileRoot, 'profiles') })
    expect(store.saveProfile(profile).status).toBe('saved')
    const counters = { starts: 0, stops: 0, active: 0, max: 0, events: [] as string[] }
    const factory = vi.fn(() => fakeSupervisor(counters) as never)
    const make = () =>
      new DevboxOrchestrator({
        profileId: profile.id,
        profileStore: store,
        journalRoot: join(profileRoot, 'journals'),
        env: {},
        supervisorFactory: factory
      })
    const first = make()
    await first.start()
    await first.disable()
    const second = make()
    await second.start()
    await second.disable()
    expect(second.status().journalRestored).toBe(true)
    expect(counters.starts).toBe(2)
    expect(counters.stops).toBe(2)
    expect(counters.active).toBe(0)
    expect(counters.max).toBe(1)
    expect(counters.events).toEqual(['flush', 'pause', 'verify', 'flush', 'pause', 'verify'])
  })

  it('holds a verified generation lease until a consistent job launch returns', async () => {
    const profileRoot = root()
    const store = new DevboxProfileStore({ rootDir: join(profileRoot, 'profiles') })
    expect(store.saveProfile(profile).status).toBe('saved')
    const supervisor = fakeSupervisor({ starts: 0, stops: 0, active: 0, max: 0, events: [] })
    const release = vi.fn(async () => undefined)
    const waitForCompletion = vi.fn(async () => ({ id: 'job-1', status: 'completed' }))
    const launch = vi.fn(async (spec: { cwd: string }) => ({
      job: { id: 'job-1', cwd: spec.cwd, status: 'running' },
      attached: false
    }))
    const orchestrator = new DevboxOrchestrator({
      profileId: profile.id,
      profileStore: store,
      journalRoot: join(profileRoot, 'journals'),
      env: {},
      supervisorFactory: () => supervisor as never,
      jobs: { launch, waitForCompletion } as never,
      generation: {
        createGeneration: async () => ({
          id: 'generation-1',
          root: '/isolated-generation',
          manifestHash: 'hash-1',
          verified: true as const,
          lease: { release }
        })
      }
    })
    await orchestrator.start()
    const run = orchestrator.runConsistent({
      id: 'job-1',
      command: ['phi'],
      cwd: '/live',
      detached: true
    })
    await run
    expect(launch).toHaveBeenCalledWith({
      id: 'job-1',
      command: ['phi'],
      cwd: '/isolated-generation',
      detached: true
    })
    expect(waitForCompletion).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses a consistent run when the remote generation was not materialized', async () => {
    const profileRoot = root()
    const store = new DevboxProfileStore({ rootDir: join(profileRoot, 'profiles') })
    expect(store.saveProfile(profile).status).toBe('saved')
    const supervisor = fakeSupervisor({ starts: 0, stops: 0, active: 0, max: 0, events: [] })
    const launch = vi.fn()
    const orchestrator = new DevboxOrchestrator({
      profileId: profile.id,
      profileStore: store,
      journalRoot: join(profileRoot, 'journals'),
      env: {},
      supervisorFactory: () => supervisor as never,
      jobs: { launch } as never,
      generation: {
        createGeneration: async () => ({
          id: 'generation-missing-remote',
          root: '/missing-remote-generation',
          manifestHash: 'hash-1',
          verified: true as const,
          materialized: false,
          lease: null
        })
      }
    })
    await orchestrator.start()
    await expect(orchestrator.runConsistent({ id: 'job-missing', command: ['true'], cwd: '/live', detached: true }))
      .rejects.toMatchObject({ context: { field: 'remote-generation-materialization' } })
    expect(launch).not.toHaveBeenCalled()
  })

  it('requires acknowledgement before forwarding a wildcard listener', async () => {
    const profileRoot = root()
    const store = new DevboxProfileStore({ rootDir: join(profileRoot, 'profiles') })
    expect(store.saveProfile(profile).status).toBe('saved')
    const supervisor = fakeSupervisor({ starts: 0, stops: 0, active: 0, max: 0, events: [] })
    const openForward = vi.fn()
    const orchestrator = new DevboxOrchestrator({
      profileId: profile.id,
      profileStore: store,
      journalRoot: join(profileRoot, 'journals'),
      env: {},
      supervisorFactory: () => supervisor as never,
      ports: {
        inspectListener: async () => ({ address: '0.0.0.0', kind: 'wildcard' as const }),
        openForward
      }
    })
    await orchestrator.start()
    await expect(orchestrator.openPort(3000)).rejects.toMatchObject({
      context: { field: 'public-listener-acknowledgement' }
    })
    await orchestrator.openPort(3000, true)
    expect(openForward).toHaveBeenCalledWith({
      targetId: 'target-1',
      remotePort: 3000,
      remoteHost: '127.0.0.1',
      label: undefined
    })
  })
})
