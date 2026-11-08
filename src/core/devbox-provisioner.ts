import { randomUUID } from 'node:crypto'
import type { DevboxError } from '../shared/devbox-errors'
import { createDevboxError } from '../shared/devbox-errors'
import { validateDevboxToolchainLock } from '../shared/devbox-toolchain-lock'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type {
  DevboxProvisionResult,
  DevboxProvisionRunOptions,
  DevboxProvisionStage,
  DevboxProvisionStageId,
  DevboxProvisionState,
  DevboxProvisionerDependencies,
  DevboxRestoreResult
} from './devbox-provisioner-types'
import {
  authorizeProvision,
  callProvisioner,
  finishProvision,
  readProvisionState,
  recordProvisionStage,
  restoreProvisionBackup,
  type DevboxProvisionerContext,
  writeProvisionFiles,
  writeProvisioner
} from './devbox-provisioner-operations'
import {
  backupScript,
  bin,
  generationScript,
  json,
  sha,
  stateOf,
  stop,
  STAGES
} from './devbox-provisioner-support'

export type {
  DevboxProvisionExec,
  DevboxProvisionExecRequest,
  DevboxProvisionFile,
  DevboxProvisionResult,
  DevboxProvisionRunOptions,
  DevboxProvisionStage,
  DevboxProvisionStageId,
  DevboxProvisionState,
  DevboxProvisionerDependencies,
  DevboxRestoreResult,
  DevboxSudoPrompt
} from './devbox-provisioner-types'

export class DevboxProvisioner {
  private readonly completed = new Set<DevboxProvisionStageId>()

  constructor(
    readonly profile: DevboxProfileV1,
    private readonly deps: DevboxProvisionerDependencies
  ) {}

  run(options: DevboxProvisionRunOptions = {}): Promise<DevboxProvisionResult> {
    return this.provision(options)
  }

  async provision(options: DevboxProvisionRunOptions = {}): Promise<DevboxProvisionResult> {
    const id = options.operationId ?? `${this.profile.id}-provision-${randomUUID()}`
    const started = this.deps.clock()
    const stages: DevboxProvisionStage[] = STAGES.map((stage) => ({
      id: stage,
      status: 'pending' as const,
      resumable: true as const,
      writes: 0
    }))
    const lockResult = validateDevboxToolchainLock(options.lock)
    const lock = lockResult.ok ? lockResult.lock : undefined
    const manifest = sha(
      json({
        profile: this.profile.id,
        lock: lock ?? options.lock ?? null,
        files: options.files ?? []
      })
    )
    const username = this.profile.sshTarget.identity.username
    const root =
      options.generationRoot ??
      `/home/${username}/.local/state/devbox/${this.profile.id}/generations`
    const generation = `${root}/${manifest}`
    const current = options.currentLink ?? `${root}/../current`
    const backup =
      options.backupRoot ??
      `/home/${username}/.local/state/devbox/${this.profile.id}/backups/${id}`
    const drift: DevboxProvisionResult['drift'][number][] = [
      {
        component: 'base-package',
        expected: 'capability-constrained',
        state: 'recorded'
      }
    ]
    const context: DevboxProvisionerContext = {
      profile: this.profile,
      deps: this.deps
    }
    let state: DevboxProvisionState = {}
    let previous: string | undefined

    try {
      stop(options.signal)
      if (!lockResult.ok || !lock) {
        throw createDevboxError(
          !lockResult.ok && lockResult.reason === 'latest'
            ? 'toolchain_latest_forbidden'
            : 'toolchain_invalid'
        )
      }
      if (!options.artifactCache) {
        throw createDevboxError('toolchain_digest_invalid')
      }
      for (const artifact of lock.artifacts) {
        const cached = options.artifactCache[artifact.name] ?? new Uint8Array()
        if (sha(cached) !== artifact.sha256) {
          throw createDevboxError('toolchain_digest_invalid')
        }
      }

      const readState = this.deps.readState?.() ?? readProvisionState(context, options.signal)
      state = stateOf(await readState)
      previous =
        state.currentGeneration && state.currentGeneration !== manifest
          ? state.currentGeneration
          : undefined
      const surfaces = [
        ...new Set([
          `${root}/current`,
          generation,
          ...(options.files ?? []).map((file) => file.path),
          ...(options.backupSurfaces ?? [])
        ])
      ]
      const actions: Record<DevboxProvisionStageId, () => Promise<number>> = {
        backup: async () => {
          if (state.backups?.includes(id)) {
            return 0
          }
          return writeProvisioner(
            context,
            {
              command: 'bash',
              args: ['-s', '--', backup, ...surfaces],
              stdin: bin(backupScript)
            },
            options.signal
          )
        },
        authorization: async () => authorizeProvision(context, id, state, options),
        toolchain: async () => {
          if (state.currentGeneration === manifest) {
            return 0
          }
          await Promise.all(
            lock.artifacts.map((artifact) =>
              callProvisioner(
                context,
                {
                  command: 'devbox-upload-artifact',
                  args: [artifact.name, artifact.sha256],
                  stdin: bin(options.artifactCache![artifact.name]!)
                },
                options.signal
              )
            )
          )
          return lock.artifacts.length
        },
        generation: async () => {
          if (
            state.currentGeneration === manifest &&
            state.verifiedGenerations?.includes(manifest)
          ) {
            return 0
          }
          return writeProvisioner(
            context,
            {
              command: 'bash',
              args: ['-s', '--', root, manifest, current],
              stdin: bin(generationScript)
            },
            options.signal
          )
        },
        config: () =>
          writeProvisionFiles(context, options.files ?? [], 'config', state, options.signal),
        shell: () =>
          writeProvisionFiles(context, options.files ?? [], 'shell', state, options.signal),
        'credential-metadata': () =>
          writeProvisionFiles(
            context,
            options.files ?? [],
            'credential-metadata',
            state,
            options.signal
          ),
        verify: async () => {
          const result = await callProvisioner(
            context,
            {
              command: 'devbox-verify-generation',
              args: [generation, manifest]
            },
            options.signal
          )
          if (result.exitCode !== 0) {
            throw createDevboxError('toolchain_invalid')
          }
          return 0
        }
      }

      for (const stage of stages) {
        const journalDone = context.deps.journal
          .replay()
          .operations.some((entry) => entry.operationId === `${id}:${stage.id}`)
        if (this.completed.has(stage.id) || journalDone) {
          stage.status = 'completed'
          this.completed.add(stage.id)
          continue
        }
        stage.status = 'running'
        try {
          const count = await actions[stage.id]()
          stage.writes += count
          stage.status = 'completed'
          this.completed.add(stage.id)
          recordProvisionStage(context, id, stage.id)
        } catch (error) {
          stage.status = options.signal?.aborted ? 'cancelled' : 'blocked'
          throw error
        }
      }
      drift.push({
        component: 'toolchain',
        expected: manifest,
        observed: state.currentGeneration,
        state:
          state.currentGeneration && state.currentGeneration !== manifest ? 'detected' : 'recorded'
      })
      return finishProvision(
        context,
        id,
        started,
        'completed',
        stages,
        manifest,
        backup,
        generation,
        previous,
        drift
      )
    } catch (error) {
      const cancelled = options.signal?.aborted || (error as DevboxError)?.code === 'cancelled'
      return finishProvision(
        context,
        id,
        started,
        cancelled ? 'cancelled' : 'blocked',
        stages,
        manifest,
        backup,
        generation,
        previous,
        drift,
        error as DevboxError
      )
    }
  }

  async restoreBackup(backupPath: string, signal?: AbortSignal): Promise<DevboxRestoreResult> {
    const context: DevboxProvisionerContext = {
      profile: this.profile,
      deps: this.deps
    }
    return restoreProvisionBackup(context, backupPath, signal)
  }
}
