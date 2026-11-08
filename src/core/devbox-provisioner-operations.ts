import { randomUUID } from 'node:crypto'
import type { DevboxError } from '../shared/devbox-errors'
import { createDevboxError } from '../shared/devbox-errors'
import type {
  DevboxAuthorityEpoch,
  DevboxOperationEnvelope,
  DevboxProfileV1
} from '../shared/devbox-types'
import type { DevboxExecResult } from './devbox-preflight'
import type {
  DevboxProvisionExecRequest,
  DevboxProvisionFile,
  DevboxProvisionResult,
  DevboxProvisionRunOptions,
  DevboxProvisionStage,
  DevboxProvisionStageId,
  DevboxProvisionState,
  DevboxProvisionerDependencies,
  DevboxRestoreResult
} from './devbox-provisioner-types'
import { bin, restoreScript, sha, stateOf, stop } from './devbox-provisioner-support'

export type DevboxProvisionerContext = {
  profile: DevboxProfileV1
  deps: DevboxProvisionerDependencies
}

export async function authorizeProvision(
  context: DevboxProvisionerContext,
  id: string,
  state: DevboxProvisionState,
  options: DevboxProvisionRunOptions
): Promise<number> {
  const platform = await callProvisioner(context, { command: 'uname', args: ['-s'] }, options.signal)
  // macOS hubs have launchd and passwordless sudo is not required for Devbox's
  // user-owned state. Detached jobs are rejected before reaching provisioning.
  if (platform.exitCode === 0 && platform.stdout.trim() === 'Darwin') {
    return 0
  }
  if (!state.sudoAuthorized) {
    const checked = await callProvisioner(
      context,
      { command: 'sudo', args: ['-n', '-v'] },
      options.signal
    )
    if (checked.exitCode !== 0) {
      if (!context.deps.secureSudoPrompt) {
        throw createDevboxError('auth_required')
      }
      const secret = await context.deps.secureSudoPrompt({
        operationId: id,
        reason: 'Provisioning requires one bounded sudo authorization.'
      })
      const input = bin(`${secret}\n`)
      try {
        const authorized = await callProvisioner(
          context,
          { command: 'sudo', args: ['-S', '-v'], stdin: input },
          options.signal
        )
        if (authorized.exitCode !== 0) {
          throw createDevboxError('auth_required')
        }
      } finally {
        input.fill(0)
      }
    }
  }
  if (options.enableLinger) {
    if (!options.reviewedEnableLinger) {
      throw createDevboxError('auth_required', {
        context: { field: 'reviewedEnableLinger' }
      })
    }
    if (!state.lingerEnabled) {
      return writeProvisioner(
        context,
        {
          command: 'loginctl',
          args: ['enable-linger', context.profile.sshTarget.identity.username]
        },
        options.signal
      )
    }
  }
  return 0
}

export async function writeProvisionFiles(
  context: DevboxProvisionerContext,
  files: readonly DevboxProvisionFile[],
  kind: DevboxProvisionFile['kind'],
  state: DevboxProvisionState,
  signal?: AbortSignal
): Promise<number> {
  let count = 0
  for (const file of files.filter((candidate) => candidate.kind === kind)) {
    const data = bin(file.content)
    const expected = sha(data)
    if (state.files?.[file.path] === expected) {
      continue
    }
    await writeProvisioner(
      context,
      {
        command: 'devbox-write-file',
        args: [file.path, expected, String(file.mode ?? 0o600)],
        stdin: data
      },
      signal
    )
    count++
  }
  return count
}

export async function restoreProvisionBackup(
  context: DevboxProvisionerContext,
  backupPath: string,
  signal?: AbortSignal
): Promise<DevboxRestoreResult> {
  try {
    await writeProvisioner(
      context,
      {
        command: 'bash',
        args: ['-s', '--', backupPath],
        stdin: bin(restoreScript)
      },
      signal
    )
    return { status: 'restored' }
  } catch (error) {
    return { status: 'failed', error: error as DevboxError }
  }
}

export async function readProvisionState(
  context: DevboxProvisionerContext,
  signal?: AbortSignal
): Promise<DevboxProvisionState> {
  try {
    const result = await context.deps.remoteExec({
      command: 'devbox-state',
      args: [],
      signal
    })
    return result.exitCode === 0 ? stateOf(JSON.parse(result.stdout)) : {}
  } catch {
    return {}
  }
}

export async function callProvisioner(
  context: DevboxProvisionerContext,
  request: Omit<DevboxProvisionExecRequest, 'signal'>,
  signal?: AbortSignal
): Promise<DevboxExecResult> {
  stop(signal)
  const result = await context.deps.remoteExec({ ...request, signal })
  stop(signal)
  return result
}

export async function writeProvisioner(
  context: DevboxProvisionerContext,
  request: Omit<DevboxProvisionExecRequest, 'signal'>,
  signal?: AbortSignal
): Promise<number> {
  if ((await callProvisioner(context, request, signal)).exitCode !== 0) {
    throw createDevboxError('unknown')
  }
  return 1
}

export function recordProvisionStage(
  context: DevboxProvisionerContext,
  id: string,
  stage: DevboxProvisionStageId
): void {
  const now = context.deps.clock()
  const operation = createProvisionOperation(
    context,
    `${id}:${stage}`,
    stage === 'verify' ? 'completed' : 'provisioning',
    now
  )
  context.deps.journal.append(operation, { recordId: randomUUID() })
  context.deps.journal.checkpoint()
}

export function createProvisionOperation(
  context: DevboxProvisionerContext,
  id: string,
  phase: DevboxOperationEnvelope['phase'],
  now: number
): DevboxOperationEnvelope {
  return {
    operationId: id,
    kind: 'provision',
    phase,
    idempotencyKey: `devbox-provision:${context.profile.id}:${id}`,
    cancellation: { requested: false },
    timestamps: {
      startedAt: now,
      updatedAt: now,
      completedAt: now
    },
    authorityEpoch: {
      epoch: `provision:${context.profile.id}` as DevboxAuthorityEpoch,
      sequence: 0,
      owner: context.profile.defaultAuthority,
      observedAt: now,
      committedAt: now
    },
    status: {
      execution: { side: 'remote', state: 'completed' },
      authority: { side: context.profile.defaultAuthority, state: 'owner' },
      freshness: { state: 'fresh', observedAt: now },
      conflict: { state: 'none' },
      drift: { state: 'none' },
      connectivity: { state: 'online' },
      auth: { state: 'healthy' },
      disk: { state: 'unknown' }
    }
  }
}

export function finishProvision(
  context: DevboxProvisionerContext,
  id: string,
  started: number,
  status: DevboxProvisionResult['status'],
  stages: readonly DevboxProvisionStage[],
  manifest: string,
  backup: string,
  generation: string,
  previous: string | undefined,
  drift: DevboxProvisionResult['drift'],
  error?: DevboxError
): DevboxProvisionResult {
  const now = context.deps.clock()
  const operation = createProvisionOperation(
    context,
    id,
    status === 'completed' ? 'completed' : status,
    now
  )
  operation.timestamps = {
    startedAt: started,
    updatedAt: now,
    completedAt: now
  }
  operation.cancellation =
    status === 'cancelled'
      ? { requested: true, requestedAt: now, reason: 'user' }
      : { requested: false }
  operation.status = {
    ...operation.status,
    execution: {
      side: 'remote',
      state: status === 'completed' ? 'completed' : 'failed'
    },
    auth:
      error?.code === 'auth_required'
        ? { state: 'required', capabilities: ['sudo'] }
        : { state: 'healthy' }
  }
  return {
    status,
    operation,
    stages,
    manifestDigest: manifest,
    backupPath: backup,
    generationPath: generation,
    ...(previous ? { previousGeneration: previous } : {}),
    drift,
    ...(error ? { error } : {})
  }
}
