import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxOperationJournal } from './devbox-operation-journal'
import type { DevboxWorkspaceGenerationManager } from '../sync/devbox-workspace-generation-manager'
import type { DevboxProfileStore } from './devbox-profile-store'
import type {
  DevboxSyncSupervisor,
  DevboxSyncSupervisorStatus
} from '../sync/devbox-sync-supervisor'
import type {
  DevboxJobSpec,
  DevboxJobSupervisor,
  DevboxJobLaunchResult
} from './devbox-job-supervisor'
import type { DevboxBridgeCapabilityBroker } from './devbox-bridge-capability-broker'
import type { DevboxGitRoamingController } from './authority/devbox-git-roaming'
import type { DevboxGitRoamingStatus } from './authority/devbox-git-roaming-types'

export type DevboxOrchestratorState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'stopping'

export type DevboxOrchestratorStatus = {
  schemaVersion: 1
  profileId: string
  state: DevboxOrchestratorState
  operationId: string | null
  sync: DevboxSyncSupervisorStatus | null
  journalRestored: boolean
  generationId: string | null
  observedAt: number
  gitRoaming?: DevboxGitRoamingStatus
}

export type DevboxProjectHostAdapter = {
  ensure(input: {
    profile: DevboxProfileV1
    localPath: string
    remotePath: string
  }): Promise<{ setupId: string; executionHostId: string }>
}

export type DevboxTerminalAdapter = {
  launch(input: {
    profile: DevboxProfileV1
    setupId: string
    executionHostId: string
    remoteCwd: string
    kind: 'terminal' | 'agent'
    command?: readonly string[]
  }): Promise<unknown>
}

export type DevboxPhiAdapter = {
  launch(input: {
    profile: DevboxProfileV1
    setupId: string
    executionHostId: string
    remoteCwd: string
    capability: unknown
  }): Promise<unknown>
}

export type DevboxGenerationAdapter = {
  createGeneration(options: { leaseOwnerId: string }): Promise<{
    id: string
    root: string
    manifestHash: string
    verified: true
    /** Explicitly false means the remote execution root was not materialized. */
    materialized?: boolean
    lease: { release(): Promise<void> } | null
  }>
}

export type DevboxPortAdapter = {
  inspectListener(input: {
    targetId: string
    remotePort: number
  }): Promise<{ address: string; kind: 'loopback' | 'wildcard' | 'other' }>
  openForward(input: {
    targetId: string
    remotePort: number
    remoteHost: string
    label?: string
  }): Promise<unknown>
  closeAll?(): Promise<void>
}

export type DevboxOrchestratorOptions = {
  profileId: string
  profileStore: DevboxProfileStore
  journalRoot: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  supervisorFactory?: (input: {
    profile: DevboxProfileV1
    journal: DevboxOperationJournal
    onStatus: (status: DevboxSyncSupervisorStatus) => void
  }) => DevboxSyncSupervisor
  projectHost?: DevboxProjectHostAdapter
  terminal?: DevboxTerminalAdapter
  phi?: DevboxPhiAdapter
  bridge?: DevboxBridgeCapabilityBroker
  gitRoaming?: DevboxGitRoamingController
  jobs?: DevboxJobSupervisor
  generation?: DevboxGenerationAdapter | DevboxWorkspaceGenerationManager
  ports?: DevboxPortAdapter
  onStatus?: (status: DevboxOrchestratorStatus) => void
  dispose?: () => Promise<void>
}

export type DevboxConsistentRun = {
  spec: DevboxJobSpec
  result: DevboxJobLaunchResult
}
