import type { DevboxProfileV1 } from '../shared/devbox-types'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxOperationJournal } from './devbox-operation-journal'
import type { DevboxProfileStore } from './devbox-profile-store'
import {
  DevboxSyncSupervisor,
  type DevboxSyncSupervisorStatus
} from '../sync/devbox-sync-supervisor'
import type { DevboxJobSpec, DevboxJobLaunchResult } from './devbox-job-supervisor'
import type { DevboxManagedBridgeSession } from '../shared/devbox-bridge-capabilities'
import {
  launchDevboxPhi,
  launchDevboxTerminal,
  openDevboxPort,
  routeDevboxProject,
  runDevboxConsistent
} from './devbox-orchestrator-actions'
import { appendDevboxOperation } from './devbox-orchestrator-journal'
import { createOrchestratorRuntime } from './devbox-orchestrator-runtime'
import type {
  DevboxOrchestratorOptions,
  DevboxOrchestratorState,
  DevboxOrchestratorStatus
} from './devbox-orchestrator-types'
export type * from './devbox-orchestrator-types'

export class DevboxOrchestrator {
  private readonly profileStore: DevboxProfileStore
  private readonly journalRoot: string
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly now: () => number
  private readonly options: DevboxOrchestratorOptions
  private tail: Promise<unknown> = Promise.resolve()
  private profile: DevboxProfileV1 | null = null
  private journal: DevboxOperationJournal | null = null
  private supervisor: DevboxSyncSupervisor | null = null
  private usingDefaultSupervisor = false
  private lastStatusEventAt = 0
  private statusValue: DevboxOrchestratorStatus

  constructor(options: DevboxOrchestratorOptions) {
    this.options = options
    this.profileStore = options.profileStore
    this.journalRoot = options.journalRoot
    this.env = options.env
    this.now = options.now ?? Date.now
    this.statusValue = {
      schemaVersion: 1,
      profileId: options.profileId,
      state: 'stopped',
      operationId: null,
      sync: null,
      journalRestored: false,
      generationId: null,
      observedAt: this.now()
    }
  }

  start(): Promise<DevboxOrchestratorStatus> {
    return this.enqueue(async () => {
      this.setState('starting')
      await this.ensureRuntime()
      if (!this.supervisor) {
        throw createDevboxError('operation_conflict', { context: { field: 'sync-supervisor' } })
      }
      await this.options.gitRoaming?.initialize()
      this.writeJournal('preparing', 'pair')
      const sync = await this.supervisor.start()
      this.statusValue = {
        ...this.statusValue,
        state: sync.state === 'degraded' ? 'degraded' : 'ready',
        sync,
        ...(this.options.gitRoaming ? { gitRoaming: await this.options.gitRoaming.status() } : {}),
        observedAt: this.now()
      }
      this.writeJournal('ready', 'pair')
      this.emit()
      return this.statusValue
    })
  }

  status(): DevboxOrchestratorStatus {
    return this.statusValue
  }

  statusLive(): Promise<DevboxOrchestratorStatus> {
    return this.enqueue(async () => {
      await this.ensureRuntime()
      if (!this.supervisor) {
        return this.statusValue
      }
      const sync = await this.supervisor.status()
      this.statusValue = {
        ...this.statusValue,
        state: sync.state === 'degraded' ? 'degraded' : sync.state === 'running' || sync.sessions.length > 0 ? 'ready' : 'stopped',
        sync,
        ...(this.options.gitRoaming ? { gitRoaming: await this.options.gitRoaming.status() } : {}),
        observedAt: this.now()
      }
      return this.statusValue
    })
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      await this.supervisor?.dispose()
      if (this.usingDefaultSupervisor) {
        DevboxSyncSupervisor.releaseProfile(this.statusValue.profileId)
      }
      this.supervisor = null
      this.profile = null
      this.journal = null
      this.usingDefaultSupervisor = false
      await this.options.ports?.closeAll?.()
      await this.options.dispose?.()
    })
  }

  disable(): Promise<DevboxOrchestratorStatus> {
    return this.enqueue(async () => {
      await this.ensureRuntime()
      if (!this.supervisor) {
        return this.statusValue
      }
      this.setState('stopping')
      this.writeJournal('quiescing', 'disable')
      await this.supervisor.shutdownForDisable()
      if (this.usingDefaultSupervisor) {
        DevboxSyncSupervisor.releaseProfile(this.statusValue.profileId)
      }
      this.supervisor = null
      this.usingDefaultSupervisor = false
      this.profile = null
      this.statusValue = {
        ...this.statusValue,
        state: 'stopped',
        sync: null,
        observedAt: this.now()
      }
      this.emit()
      return this.statusValue
    })
  }

  handoff(targetOwner: 'local' | 'remote') {
    return this.enqueue(async () => {
      if (!this.options.gitRoaming) {throw createDevboxError('operation_conflict', { context: { field: 'git-roaming-disabled' } })}
      const result = await this.options.gitRoaming.handoff(targetOwner, this.supervisor ? {
        flush: () => this.supervisor!.flush(),
        pause: () => this.supervisor!.pause(),
        verify: async () => { const status = await this.supervisor!.verify(); return { conflictCount: status.conflictCount, fresh: status.sessions.every((session) => session.observation.freshness === 'fresh') } },
        resume: () => this.supervisor!.resume(),
        status: async () => { const status = await this.supervisor!.status(); return { state: status.state === 'paused' ? 'paused' : status.state === 'running' ? 'running' : 'stopped', conflictCount: status.conflictCount, fresh: status.sessions.every((session) => session.observation.freshness === 'fresh') } }
      } : undefined)
      this.statusValue = { ...this.statusValue, gitRoaming: await this.options.gitRoaming.status(), observedAt: this.now() }
      return result
    })
  }

  runGit(side: 'local' | 'remote', repositoryPath: string, argv: readonly string[]) {
    return this.enqueue(async () => {
      if (!this.options.gitRoaming) {throw createDevboxError('operation_conflict', { context: { field: 'git-roaming-disabled' } })}
      return this.options.gitRoaming.runGit(side, repositoryPath, argv)
    })
  }

  routeProject(localPath: string) {
    return this.enqueue(() =>
      routeDevboxProject(this.requireProfile(), localPath, this.options.projectHost)
    )
  }

  launchTerminal(localPath: string, kind: 'terminal' | 'agent', command?: readonly string[]) {
    return this.enqueue(() =>
      launchDevboxTerminal(
        this.requireProfile(),
        localPath,
        kind,
        command,
        this.options.projectHost,
        this.options.terminal
      )
    )
  }

  launchPhi(
    localPath: string,
    sessionId: string,
    relayEpoch: DevboxManagedBridgeSession['relayEpoch']
  ) {
    return this.enqueue(() =>
      launchDevboxPhi(
        this.requireProfile(),
        localPath,
        sessionId,
        relayEpoch,
        this.options.projectHost,
        this.options.phi,
        this.options.bridge
      )
    )
  }

  runConsistent(spec: DevboxJobSpec): Promise<DevboxJobLaunchResult> {
    return this.enqueue(async () => {
      const run = await runDevboxConsistent(spec, this.options.jobs, this.options.generation)
      this.statusValue = {
        ...this.statusValue,
        generationId: run.generationId,
        observedAt: this.now()
      }
      return run.result
    })
  }

  jobStatus(id: string) {
    return this.enqueue(async () => this.requireJobs().status(id))
  }

  waitForJob(id: string) {
    return this.enqueue(async () => this.requireJobs().waitForCompletion(id))
  }

  cancelJob(id: string): Promise<void> {
    return this.enqueue(async () => this.requireJobs().cancel(id))
  }

  tailJobLog(id: string, offset = 0, limit = 64 * 1024) {
    return this.enqueue(async () => {
      const jobs = this.requireJobs()
      return typeof jobs.tailLogLive === 'function' ? jobs.tailLogLive(id, offset, limit) : jobs.tailLog(id, offset, limit)
    })
  }

  openPort(remotePort: number, allowPublicListener = false, label?: string) {
    return this.enqueue(() =>
      openDevboxPort(
        this.requireProfile(),
        remotePort,
        allowPublicListener,
        label,
        this.options.ports
      )
    )
  }

  private ensureRuntime(): void {
    if (this.supervisor && this.profile && this.journal) {return}
    const runtime = createOrchestratorRuntime({
      profileId: this.statusValue.profileId,
      profileStore: this.profileStore,
      journalRoot: this.journalRoot,
      env: this.env,
      options: this.options,
      onStatus: (status) => this.onSyncStatus(status)
    })
    this.profile = runtime.profile
    this.journal = runtime.journal
    this.supervisor = runtime.supervisor
    this.usingDefaultSupervisor = runtime.usingDefaultSupervisor
    this.statusValue = { ...this.statusValue, journalRestored: runtime.journalRestored }
  }

  private requireJobs() {
    if (!this.options.jobs) {
      throw createDevboxError('operation_conflict', { context: { field: 'job-adapter' } })
    }
    return this.options.jobs
  }

  private requireProfile(): DevboxProfileV1 {
    if (!this.profile || !this.supervisor) {
      throw createDevboxError('offline')
    }
    return this.profile
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private setState(state: DevboxOrchestratorState): void {
    this.statusValue = { ...this.statusValue, state, observedAt: this.now() }
    this.emit()
  }

  private onSyncStatus(sync: DevboxSyncSupervisorStatus): void {
    this.statusValue = {
      ...this.statusValue,
      state: sync.state === 'degraded' ? 'degraded' : this.statusValue.state,
      sync,
      observedAt: this.now()
    }
    this.emit()
  }

  private writeJournal(phase: 'preparing' | 'quiescing' | 'ready', kind: 'pair' | 'disable'): void {
    if (!this.journal) {
      return
    }
    const now = this.now()
    const operationId = appendDevboxOperation(this.journal, this.profile, this.statusValue, phase, kind, now)
    this.statusValue = { ...this.statusValue, operationId, observedAt: now }
  }

  private emit(): void {
    const now = this.now()
    const terminalState =
      this.statusValue.state === 'ready' || this.statusValue.state === 'stopped'
    if (!terminalState && now - this.lastStatusEventAt < 100) {
      return
    }
    this.lastStatusEventAt = now
    this.options.onStatus?.(this.statusValue)
  }
}
