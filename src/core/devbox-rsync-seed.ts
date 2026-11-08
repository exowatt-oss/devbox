import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import {
  acceptDevboxRsyncPlan,
  createDevboxRsyncPairDigest,
  createDevboxRsyncPlan,
  verifyDevboxRsync
} from './devbox-rsync-capacity'
import { DEVBOX_RSYNC_LEAN_FILTER } from './devbox-rsync-filter'
import {
  backupDevboxRsync,
  collectDevboxTrackedFiles,
  executeDevboxRsync,
  executeDevboxTrackedRsync,
  readDevboxRsyncBaseline,
  relocateDevboxRsyncPaths,
  writeDevboxRsyncFile
} from './devbox-rsync-tracked'
import { sha } from './devbox-rsync-inventory'
import type {
  DevboxRsyncAcceptance,
  DevboxRsyncResolution,
  DevboxRsyncSeedDependencies,
  DevboxRsyncSeedOptions,
  DevboxRsyncSeedPlan,
  DevboxRsyncSeedResult
} from './devbox-rsync-types'

export class RsyncSeedAndRepair {
  private readonly deps: DevboxRsyncSeedDependencies

  constructor(
    readonly profile: DevboxProfileV1,
    dependencies: DevboxRsyncSeedDependencies
  ) {
    this.deps = dependencies
  }

  async createPlan(
    options: Pick<DevboxRsyncSeedOptions, 'source' | 'signal' | 'baselinePath' | 'capacity'> = {}
  ): Promise<DevboxRsyncSeedPlan> {
    return createDevboxRsyncPlan(this.profile, options)
  }

  acceptPlan(
    plan: DevboxRsyncSeedPlan,
    resolutions: readonly DevboxRsyncResolution[] = []
  ): DevboxRsyncAcceptance {
    return acceptDevboxRsyncPlan(plan, resolutions)
  }
  async plan(
    options?: Pick<DevboxRsyncSeedOptions, 'source' | 'signal' | 'baselinePath' | 'capacity'>
  ): Promise<DevboxRsyncSeedPlan> {
    return this.createPlan(options)
  }
  async buildPlan(
    options?: Pick<DevboxRsyncSeedOptions, 'source' | 'signal' | 'baselinePath' | 'capacity'>
  ): Promise<DevboxRsyncSeedPlan> {
    return this.createPlan(options)
  }
  accept(
    plan: DevboxRsyncSeedPlan,
    resolutions: readonly DevboxRsyncResolution[] = []
  ): DevboxRsyncAcceptance {
    return this.acceptPlan(plan, resolutions)
  }
  async run(options: DevboxRsyncSeedOptions = {}): Promise<DevboxRsyncSeedResult> {
    return this.seed(options)
  }
  async adopt(options: DevboxRsyncSeedOptions = {}): Promise<DevboxRsyncSeedResult> {
    return this.seed(options)
  }
  async repair(options: DevboxRsyncSeedOptions = {}): Promise<DevboxRsyncSeedResult> {
    return this.seed(options)
  }
  async seed(options: DevboxRsyncSeedOptions = {}): Promise<DevboxRsyncSeedResult> {
    const operationId = options.operationId ?? `seed-${randomUUID()}`
    const baselinePath =
      options.baselinePath ??
      join(
        options.source === 'remote' ? this.profile.roots.localRoot : this.profile.roots.remoteRoot,
        '.devbox-baseline.json'
      )

    try {
      const plan = await this.createPlan({ ...options, baselinePath })
      const stored = await readDevboxRsyncBaseline(baselinePath)
      const currentPair = createDevboxRsyncPairDigest(plan, this.profile, stored?.trackedPaths)

      if (stored?.pairDigest === currentPair) {
        return {
          status: 'noop',
          plan,
          baselinePath,
          commands: 0,
          manifestDigest: stored.manifestDigest,
          verifiedNoop: true
        }
      }

      const reason = plan.capacity?.byteDeficit
        ? 'byte-deficit'
        : plan.capacity?.inodeDeficit
          ? 'inode-deficit'
          : plan.comparisons.some((item) => item.classification === 'type-conflict')
            ? 'type-conflict'
            : undefined
      if (reason) {
        return this.result('blocked', plan, baselinePath, 0, reason)
      }

      if (plan.requiresAcceptance) {
        const acceptance =
          options.acceptance ??
          (options.accepted ? this.acceptPlan(plan, options.resolutions ?? []) : undefined)
        if (!acceptance?.accepted || acceptance.planDigest !== plan.digest) {
          return this.result('blocked', plan, baselinePath, 0, 'plan-required')
        }
        if (!this.acceptPlan(plan, acceptance.resolutions).accepted) {
          return this.result('blocked', plan, baselinePath, 0, 'unresolved-conflict')
        }
      }

      await relocateDevboxRsyncPaths(
        this.profile,
        plan.sourceRoot,
        plan.source === 'local' ? 'local-to-remote' : 'remote-to-local',
        options.signal,
        false
      )
      const resolutions = new Map(
        (options.acceptance?.resolutions ?? options.resolutions ?? []).map((item) => [
          item.relativePath,
          item.keep
        ])
      )
      const stagingRoot = options.stagingRoot ?? join(tmpdir(), 'devbox-seed')
      const filterPath = options.filterPath ?? join(stagingRoot, `${operationId}.filter`)
      const divergent = plan.comparisons.filter(
        (item) => item.classification === 'divergent-same-path'
      )
      const backupPaths = divergent.flatMap((item) => [
        join(this.profile.roots.localRoot, item.relativePath),
        join(this.profile.roots.remoteRoot, item.relativePath)
      ])
      const backupPath = divergent.length
        ? await backupDevboxRsync(operationId, backupPaths, this.deps, (path, data) =>
            writeDevboxRsyncFile(path, data, this.deps)
          )
        : undefined
      const destinationKept = [...resolutions.entries()]
        .filter(([, keep]) => keep === plan.destination)
        .map(([path]) => path)

      await writeDevboxRsyncFile(filterPath, `${DEVBOX_RSYNC_LEAN_FILTER.join('\n')}\n`, this.deps)
      let commands = 0
      commands += await executeDevboxRsync(
        plan,
        options,
        destinationKept,
        false,
        filterPath,
        this.deps
      )

      const tracked = await collectDevboxTrackedFiles(plan.sourceRoot, this.deps, options.signal)
      const trackedList = options.trackedListPath ?? join(stagingRoot, `${operationId}.tracked`)
      await writeDevboxRsyncFile(
        trackedList,
        Buffer.from(`${tracked.join('\0')}${tracked.length ? '\0' : ''}`),
        this.deps
      )
      commands += await executeDevboxTrackedRsync(plan, trackedList, options, this.deps)
      commands += await executeDevboxRsync(
        plan,
        options,
        destinationKept,
        false,
        filterPath,
        this.deps
      )

      for (const [path, keep] of resolutions) {
        if (keep === plan.destination) {
          commands += await executeDevboxRsync(plan, options, [path], true, filterPath, this.deps)
        }
      }

      const verified = await verifyDevboxRsync(plan, tracked, resolutions, options.signal)
      if (!verified) {
        return this.result(
          'blocked',
          plan,
          baselinePath,
          commands,
          'verification-failed',
          backupPath
        )
      }

      await relocateDevboxRsyncPaths(
        this.profile,
        plan.destinationRoot,
        plan.source === 'local' ? 'local-to-remote' : 'remote-to-local',
        options.signal,
        true
      )
      const finalPlan = await this.createPlan({ ...options, baselinePath })
      const finalEntries = finalPlan[finalPlan.destination === 'local' ? 'local' : 'remote']
      const manifestDigest = sha(JSON.stringify(finalEntries))
      const pairDigest = createDevboxRsyncPairDigest(finalPlan, this.profile, tracked)
      await writeDevboxRsyncFile(
        baselinePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            pairDigest,
            manifestDigest,
            trackedPaths: tracked
          },
          null,
          2
        ),
        this.deps
      )

      return {
        status: 'completed',
        plan: finalPlan,
        baselinePath,
        commands,
        manifestDigest,
        ...(backupPath ? { backupPath } : {})
      }
    } catch (error) {
      const devboxError = (error as DevboxError).code
        ? (error as DevboxError)
        : createDevboxError('unknown')
      return this.result(
        devboxError.code === 'cancelled' ? 'cancelled' : 'blocked',
        await this.createPlan({ ...options, baselinePath }),
        baselinePath,
        0,
        devboxError.code === 'cancelled' ? undefined : 'rsync-failed',
        undefined,
        devboxError
      )
    }
  }

  private result(
    status: 'blocked' | 'cancelled',
    plan: DevboxRsyncSeedPlan,
    baselinePath: string,
    commands: number,
    reason?: DevboxRsyncSeedResult['reason'],
    backupPath?: string,
    error?: DevboxError
  ): DevboxRsyncSeedResult {
    return {
      status,
      plan,
      baselinePath,
      commands,
      ...(reason ? { reason } : {}),
      ...(backupPath ? { backupPath } : {}),
      ...(error ? { error } : {})
    }
  }
}

export {
  DEVBOX_CANONICAL_LEAN_FILTER,
  DEVBOX_RSYNC_BASE_OPTIONS,
  DEVBOX_RSYNC_LEAN_FILTER,
  DEVBOX_RSYNC_TRACKED_OPTIONS
} from './devbox-rsync-filter'
export { calculateDevboxRsyncCapacity } from './devbox-rsync-capacity'
export { collectDevboxTrackedFiles } from './devbox-rsync-tracked'
export { inventoryDevboxRsyncEntries } from './devbox-rsync-inventory'
export type {
  DevboxAdoptionClassification,
  DevboxAdoptionComparison,
  DevboxRsyncAcceptance,
  DevboxRsyncCapacity,
  DevboxRsyncCapacityInput,
  DevboxRsyncEntryKind,
  DevboxRsyncExecRequest,
  DevboxRsyncInventoryEntry,
  DevboxRsyncResolution,
  DevboxRsyncSeedDependencies,
  DevboxRsyncSeedOptions,
  DevboxRsyncSeedPlan,
  DevboxRsyncSeedResult,
  DevboxRsyncSide
} from './devbox-rsync-types'
