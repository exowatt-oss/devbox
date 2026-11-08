import type { DevboxError } from '../shared/devbox-errors'
import type { DevboxToolchainLockV1 } from '../shared/devbox-toolchain-lock'
import type { DevboxOperationEnvelope } from '../shared/devbox-types'
import type { DevboxOperationJournal } from './devbox-operation-journal'
import type { DevboxExecRequest, DevboxExecResult } from './devbox-preflight'

export type DevboxProvisionExecRequest = DevboxExecRequest & {
  stdin?: Uint8Array
}

export type DevboxProvisionExec = (request: DevboxProvisionExecRequest) => Promise<DevboxExecResult>

export type DevboxSudoPrompt = (request: { operationId: string; reason: string }) => Promise<string>

export type DevboxProvisionFile = {
  path: string
  content: string | Uint8Array
  mode?: number
  kind?: 'config' | 'shell' | 'credential-metadata'
}

export type DevboxProvisionState = {
  currentGeneration?: string
  verifiedGenerations?: readonly string[]
  backups?: readonly string[]
  files?: Readonly<Record<string, string>>
  sudoAuthorized?: boolean
  lingerEnabled?: boolean
}

export type DevboxProvisionerDependencies = {
  remoteExec: DevboxProvisionExec
  journal: DevboxOperationJournal
  clock: () => number
  secureSudoPrompt?: DevboxSudoPrompt
  readState?: () => Promise<DevboxProvisionState>
}

export type DevboxProvisionRunOptions = {
  operationId?: string
  signal?: AbortSignal
  lock?: DevboxToolchainLockV1
  artifactCache?: Readonly<Record<string, Uint8Array>>
  generationRoot?: string
  currentLink?: string
  backupRoot?: string
  backupSurfaces?: readonly string[]
  files?: readonly DevboxProvisionFile[]
  enableLinger?: boolean
  reviewedEnableLinger?: boolean
}

export type DevboxProvisionStageId =
  | 'backup'
  | 'authorization'
  | 'toolchain'
  | 'generation'
  | 'config'
  | 'shell'
  | 'credential-metadata'
  | 'verify'

export type DevboxProvisionStage = {
  id: DevboxProvisionStageId
  status: 'pending' | 'running' | 'completed' | 'blocked' | 'cancelled'
  resumable: true
  writes: number
}

export type DevboxProvisionResult = {
  status: 'completed' | 'blocked' | 'cancelled'
  operation: DevboxOperationEnvelope
  stages: readonly DevboxProvisionStage[]
  manifestDigest: string
  backupPath: string
  generationPath: string
  previousGeneration?: string
  error?: DevboxError
  drift: readonly {
    component: 'base-package' | 'toolchain' | 'helper'
    expected: string
    observed?: string
    state: 'recorded' | 'detected'
  }[]
}

export type DevboxRestoreResult = {
  status: 'restored' | 'failed'
  error?: DevboxError
}
