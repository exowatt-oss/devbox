import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxSyncBackend } from './devbox-sync-backend'
import { copyTree } from './devbox-generation-copy'
import { DevboxGenerationLeaseStore } from './devbox-generation-lease'
import { recoverGenerationWithSync } from './devbox-generation-recovery-sync'
import {
  createManifest,
  digest,
  isWithinRoot,
  MANIFEST_FILE,
  READY_FILE
} from './devbox-generation-manifest'
import {
  listVerifiedGenerations,
  verifyManifestTree,
  verifyGenerationRoot
} from './devbox-generation-verification'

export type DevboxWorkspaceGenerationStage =
  | 'idle'
  | 'flushing'
  | 'pausing'
  | 'verifying-conflicts'
  | 'manifesting'
  | 'copying'
  | 'verifying-generation'
  | 'resuming'
  | 'ready'
  | 'recovering'
  | 'failed'

export type DevboxWorkspaceManifestEntry = {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  hash: string
  mode: number
  size?: number
  target?: string
}

export type DevboxWorkspaceManifest = {
  schemaVersion: 1
  sourceRoot: string
  createdAt: number
  entries: readonly DevboxWorkspaceManifestEntry[]
  treeHash: string
}

export type DevboxWorkspaceGenerationLease = {
  generationId: string
  ownerId: string
  release(): Promise<void>
}

export type DevboxWorkspaceGeneration = {
  id: string
  root: string
  manifest: DevboxWorkspaceManifest
  manifestHash: string
  verified: true
  /** Standalone adapters set this when the remote execution root is materialized. */
  materialized?: boolean
  lease: DevboxWorkspaceGenerationLease | null
}

export type DevboxWorkspaceGenerationStatus = {
  stage: DevboxWorkspaceGenerationStage
  generationId: string | null
  conflictCount: number
  liveSyncResumable: boolean
}

export type DevboxGenerationSync = Pick<
  DevboxSyncBackend,
  'flush' | 'pause' | 'resume' | 'listConflicts'
>

export type DevboxWorkspaceGenerationManagerOptions = {
  sourceRoot: string
  generationsRoot: string
  sync: DevboxGenerationSync
  now?: () => number
  maxRetainedGenerations?: number
  beforeStage?: (stage: DevboxWorkspaceGenerationStage) => void | Promise<void>
}

const invalid = (field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { field } })

export class DevboxWorkspaceGenerationManager {
  private readonly sourceRoot: string
  private readonly generationsRoot: string
  private readonly sync: DevboxGenerationSync
  private readonly now: () => number
  private readonly maxRetained: number
  private readonly beforeStage: DevboxWorkspaceGenerationManagerOptions['beforeStage']
  private readonly leaseStore: DevboxGenerationLeaseStore
  private statusValue: DevboxWorkspaceGenerationStatus = {
    stage: 'idle',
    generationId: null,
    conflictCount: 0,
    liveSyncResumable: true
  }

  constructor(options: DevboxWorkspaceGenerationManagerOptions) {
    const sourceRoot = resolve(options.sourceRoot)
    const generationsRoot = resolve(options.generationsRoot)
    const rootsOverlap =
      sourceRoot === generationsRoot ||
      isWithinRoot(sourceRoot, generationsRoot) ||
      isWithinRoot(generationsRoot, sourceRoot)

    if (rootsOverlap) {
      throw invalid('generation-root-must-be-isolated')
    }

    this.sourceRoot = sourceRoot
    this.generationsRoot = generationsRoot
    this.leaseStore = new DevboxGenerationLeaseStore(generationsRoot)
    this.sync = options.sync
    this.now = options.now ?? Date.now
    this.maxRetained = Math.max(1, options.maxRetainedGenerations ?? 3)
    this.beforeStage = options.beforeStage
  }

  status(): DevboxWorkspaceGenerationStatus {
    return this.statusValue
  }

  async recover(): Promise<void> {
    this.statusValue = { ...this.statusValue, stage: 'recovering', liveSyncResumable: false }
    const liveSyncResumable = await recoverGenerationWithSync(this.generationsRoot, this.sync)
    this.statusValue = { ...this.statusValue, stage: 'idle', liveSyncResumable }
  }

  async createGeneration(
    options: { leaseOwnerId?: string } | string = {}
  ): Promise<DevboxWorkspaceGeneration> {
    const leaseOwnerId = typeof options === 'string' ? options : options.leaseOwnerId
    await this.recover()

    const id = `generation-${this.now()}-${randomUUID().slice(0, 8)}`
    const staging = join(this.generationsRoot, `.staging-${id}`)
    const destination = join(this.generationsRoot, id)
    let paused = false
    let syncTouched = false
    let committed = false

    try {
      syncTouched = true

      await this.stage('flushing')
      await this.sync.flush()

      await this.stage('pausing')
      await this.sync.pause()
      paused = true

      await this.stage('verifying-conflicts')
      const conflicts = await this.sync.listConflicts()
      this.statusValue = {
        ...this.statusValue,
        conflictCount: conflicts.length
      }
      if (conflicts.length > 0) {
        throw invalid('conflicts-present')
      }

      await this.stage('manifesting')
      const expected = await createManifest(this.sourceRoot, this.now())
      await mkdir(staging, { recursive: true, mode: 0o700 })

      await this.stage('copying')
      for (const entry of expected.entries) {
        const source = join(this.sourceRoot, entry.path)
        const target = join(staging, entry.path)
        const pathsAreContained =
          isWithinRoot(this.sourceRoot, source) && isWithinRoot(staging, target)

        if (!pathsAreContained) {
          throw invalid('path-escape')
        }

        if (entry.kind === 'directory') {
          await mkdir(target, {
            recursive: true,
            mode: entry.mode & 0o7777
          })
        } else {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await copyTree(source, target)
        }
      }

      await this.stage('verifying-generation')
      await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(expected, null, 2)}\n`, {
        mode: 0o600
      })
      const verified = await verifyManifestTree(staging, expected)
      if (!verified) {
        throw invalid('manifest-mismatch')
      }

      await writeFile(join(staging, READY_FILE), `${digest(expected)}\n`, {
        mode: 0o600
      })
      await rename(staging, destination)
      committed = true

      await this.stage('resuming')
      await this.sync.resume()
      paused = false

      this.statusValue = {
        stage: 'ready',
        generationId: id,
        conflictCount: 0,
        liveSyncResumable: true
      }
      const generation: DevboxWorkspaceGeneration = {
        id,
        root: destination,
        manifest: expected,
        manifestHash: digest(expected),
        verified: true,
        lease: leaseOwnerId ? await this.acquireLease(id, leaseOwnerId) : null
      }
      await this.prune()
      return generation
    } catch (error) {
      if (!committed) {
        await rm(staging, { recursive: true, force: true })
      }
      if (syncTouched) {
        try {
          await this.sync.resume()
          paused = false
        } catch {
          // Preserve the paused state when resuming fails.
        }
      }
      this.statusValue = {
        ...this.statusValue,
        stage: 'failed',
        generationId: committed ? id : null,
        liveSyncResumable: !paused
      }
      throw error
    }
  }

  async verifyGeneration(generationId: string): Promise<boolean> {
    return verifyGenerationRoot(join(this.generationsRoot, generationId))
  }

  async verifyManifest(generationId: string): Promise<boolean> {
    return this.verifyGeneration(generationId)
  }

  async listGenerations(): Promise<readonly DevboxWorkspaceGeneration[]> {
    return listVerifiedGenerations(this.generationsRoot)
  }

  async acquireLease(
    generationId: string,
    ownerId: string = randomUUID()
  ): Promise<DevboxWorkspaceGenerationLease> {
    return this.leaseStore.acquire(generationId, ownerId, (id) => this.verifyGeneration(id))
  }

  async prune(maxRetainedGenerations = this.maxRetained): Promise<readonly string[]> {
    const generations = await this.listGenerations()
    const removed: string[] = []
    const keep = Math.max(1, maxRetainedGenerations)
    const candidates = generations.slice(0, Math.max(0, generations.length - keep))

    for (const generation of candidates) {
      if (await this.hasLease(generation.id)) {
        continue
      }
      await rm(generation.root, { recursive: true, force: true })
      removed.push(generation.id)
    }
    return removed
  }

  private async stage(stage: DevboxWorkspaceGenerationStage): Promise<void> {
    this.statusValue = { ...this.statusValue, stage }
    await this.beforeStage?.(stage)
  }

  async releaseLease(lease: DevboxWorkspaceGenerationLease): Promise<void> {
    await lease.release()
  }

  private async hasLease(generationId: string): Promise<boolean> {
    return this.leaseStore.hasLease(generationId)
  }
}
