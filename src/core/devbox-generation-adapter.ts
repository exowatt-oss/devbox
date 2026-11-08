import { join } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import { shellEscape } from '../ssh/shell-escape'
import type { DevboxProfileStore } from './devbox-profile-store'
import { devboxSyncRequests } from './devbox-orchestrator-actions'
import { DevboxSyncSupervisor } from '../sync/devbox-sync-supervisor'
import {
  DevboxWorkspaceGenerationManager,
  type DevboxGenerationSync,
  type DevboxWorkspaceGeneration
} from '../sync/devbox-workspace-generation-manager'
import type { DevboxGenerationAdapter as DevboxGenerationAdapterContract } from './devbox-orchestrator-types'

export type DevboxGenerationAdapterOptions = {
  profileId: string
  profileStore: DevboxProfileStore
  generationsRoot: string
  env?: NodeJS.ProcessEnv
  runner?: DevboxSshRunner
  syncSupervisor?: DevboxGenerationSync | (() => DevboxGenerationSync)
}

export class DevboxGenerationAdapter implements DevboxGenerationAdapterContract {
  private readonly options: DevboxGenerationAdapterOptions
  private manager: DevboxWorkspaceGenerationManager | null = null

  constructor(options: DevboxGenerationAdapterOptions) {
    this.options = options
  }

  async createGeneration(options: { leaseOwnerId: string }): Promise<DevboxWorkspaceGeneration> {
    const manager = this.getManager()
    const generation = await manager.createGeneration({ leaseOwnerId: options.leaseOwnerId })
    const runner = this.options.runner
    if (!runner) {
      return generation
    }
    const loaded = this.options.profileStore.loadProfile(this.options.profileId)
    if (loaded.status !== 'loaded') {
      await generation.lease?.release().catch(() => undefined)
      throw createDevboxError('profile_not_found')
    }
    let remoteRoot = ''
    try {
      const home = (await runner.command('printf %s "$HOME"', 10_000)).trim()
      if (!home.startsWith('/')) {
        throw new Error('remote HOME is not absolute')
      }
      remoteRoot = join(home, '.local', 'state', 'devbox', loaded.profile.id, 'generations', generation.id)
      await runner.script([
        'set -Eeuo pipefail',
        `source=${shellEscape(loaded.profile.roots.remoteRoot)}`,
        `destination=${shellEscape(remoteRoot)}`,
        'test -d "$source"',
        'mkdir -p "$(dirname "$destination")"',
        'rm -rf "$destination"',
        'mkdir -p "$destination"',
        'cp -a "$source"/. "$destination"/',
        'test -d "$destination"'
      ].join('\n'), 30_000)
    } catch {
      await generation.lease?.release().catch(() => undefined)
      throw createDevboxError('operation_conflict', {
        context: { profileId: loaded.profile.id, field: 'remote-generation-materialization' }
      })
    }
    return { ...generation, root: remoteRoot, materialized: true }
  }

  private getManager(): DevboxWorkspaceGenerationManager {
    if (this.manager) {
      return this.manager
    }
    const loaded = this.options.profileStore.loadProfile(this.options.profileId)
    if (loaded.status !== 'loaded') {
      throw new Error(`Devbox profile ${this.options.profileId} is not available.`)
    }
    const supervisor =
      typeof this.options.syncSupervisor === 'function'
        ? this.options.syncSupervisor()
        : this.options.syncSupervisor ??
          DevboxSyncSupervisor.forProfile({
            profileId: loaded.profile.id,
            requests: devboxSyncRequests(loaded.profile)
          })
    this.manager = new DevboxWorkspaceGenerationManager({
      sourceRoot: loaded.profile.roots.localRoot,
      generationsRoot: join(this.options.generationsRoot, loaded.profile.id),
      sync: supervisor
    })
    return this.manager
  }
}
