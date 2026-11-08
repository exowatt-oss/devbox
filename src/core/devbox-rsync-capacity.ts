import type { DevboxProfileV1 } from '../shared/devbox-types'
import { relative } from 'node:path'
import { DevboxPathMapper } from './devbox-path-mapper'
import { filterMatches } from './devbox-rsync-filter'
import {
  compareEntries,
  digestPlan,
  inventory,
  isPointer,
  sha,
  sorted
} from './devbox-rsync-inventory'
import type {
  DevboxRsyncAcceptance,
  DevboxRsyncCapacity,
  DevboxRsyncCapacityInput,
  DevboxRsyncInventoryEntry,
  DevboxRsyncResolution,
  DevboxRsyncSeedOptions,
  DevboxRsyncSeedPlan,
  DevboxRsyncSide
} from './devbox-rsync-types'

export function calculateDevboxRsyncCapacity(input: DevboxRsyncCapacityInput): DevboxRsyncCapacity {
  const staging = input.stagingBytes ?? input.syncStagingBytes ?? 0
  const generations =
    input.generationsBytes ??
    input.generationBytes ??
    (input.runtimeGenerationBytes ?? 0) + (input.consistentWorkspaceBytes ?? 0)
  const lean = input.leanSeedBytes ?? 0
  const tracked = input.trackedRestoreBytes ?? 0
  const block = input.blockReserveBytes ?? input.blockReserve ?? 10 * 1024 ** 3
  const reserve = input.inodeReserve ?? 100_000
  const requiredBytes = lean + tracked + staging + generations + block
  const requiredInodes = reserve + (input.estimatedInodes ?? 0)

  return {
    ...input,
    leanSeedBytes: lean,
    trackedRestoreBytes: tracked,
    stagingBytes: staging,
    generationsBytes: generations,
    blockReserveBytes: block,
    inodeReserve: reserve,
    requiredBytes,
    requiredInodes,
    byteDeficit: Math.max(0, requiredBytes - input.freeBytes),
    inodeDeficit: Math.max(0, requiredInodes - input.freeInodes)
  }
}

export async function createDevboxRsyncPlan(
  profile: DevboxProfileV1,
  options: Pick<DevboxRsyncSeedOptions, 'source' | 'signal' | 'baselinePath' | 'capacity'> = {}
): Promise<DevboxRsyncSeedPlan> {
  const source = options.source ?? 'local'
  const destination = source === 'local' ? 'remote' : 'local'
  const localRoot = profile.roots.localRoot
  const remoteRoot = profile.roots.remoteRoot
  const baselineRoot = source === 'local' ? remoteRoot : localRoot
  const skip = options.baselinePath
    ? relative(baselineRoot, options.baselinePath).replaceAll('\\', '/')
    : undefined
  const [local, remote] = await Promise.all([
    inventory(localRoot, options.signal, source === 'remote' ? skip : undefined),
    inventory(remoteRoot, options.signal, source === 'local' ? skip : undefined)
  ])
  const comparisons = compareEntries(local, remote)
  const sourceEntries = source === 'local' ? local : remote
  const leanBytes = sourceEntries
    .filter((entry) => entry.kind === 'file' && !filterMatches(entry.relativePath))
    .reduce((sum, entry) => sum + entry.size, 0)
  const trackedBytes = sourceEntries
    .filter((entry) => entry.kind === 'file' && filterMatches(entry.relativePath))
    .reduce((sum, entry) => sum + entry.size, 0)
  const capacity = options.capacity
    ? calculateDevboxRsyncCapacity({
        ...options.capacity,
        leanSeedBytes: options.capacity.leanSeedBytes ?? leanBytes,
        trackedRestoreBytes: options.capacity.trackedRestoreBytes ?? trackedBytes,
        estimatedInodes: options.capacity.estimatedInodes ?? sourceEntries.length
      })
    : undefined
  const bothNonEmpty = local.length > 0 && remote.length > 0

  return {
    source,
    destination,
    sourceRoot: source === 'local' ? localRoot : remoteRoot,
    destinationRoot: source === 'local' ? remoteRoot : localRoot,
    local,
    remote,
    comparisons,
    bothNonEmpty,
    requiresAcceptance: bothNonEmpty,
    digest: digestPlan(comparisons),
    ...(capacity ? { capacity } : {})
  }
}

export function acceptDevboxRsyncPlan(
  plan: DevboxRsyncSeedPlan,
  resolutions: readonly DevboxRsyncResolution[] = []
): DevboxRsyncAcceptance {
  const conflicts = plan.comparisons.filter((item) => item.classification === 'divergent-same-path')
  const byPath = new Map(resolutions.map((item) => [item.relativePath, item.keep]))
  const accepted =
    !plan.comparisons.some((item) => item.classification === 'type-conflict') &&
    conflicts.every((item) => byPath.has(item.relativePath)) &&
    resolutions.every((item) =>
      conflicts.some((conflict) => conflict.relativePath === item.relativePath)
    )

  return {
    accepted,
    planDigest: plan.digest,
    resolutions: sorted(resolutions, (item) => item.relativePath)
  }
}

export function createDevboxRsyncPairDigest(
  plan: DevboxRsyncSeedPlan,
  profile: DevboxProfileV1,
  tracked: readonly string[] = []
): string {
  const trackedSet = new Set(tracked)
  const normalize = (side: DevboxRsyncSide, entries: readonly DevboxRsyncInventoryEntry[]) =>
    sorted(
      entries.filter(
        (entry) => !filterMatches(entry.relativePath) || trackedSet.has(entry.relativePath)
      ),
      (entry) => entry.relativePath
    ).map((entry) => {
      const target =
        entry.kind === 'symlink' && entry.target
          ? new DevboxPathMapper(profile).relocateSymlinkTarget(
              entry.target,
              side === 'local' ? 'local-to-remote' : 'remote-to-local'
            )
          : undefined
      const normalizedTarget =
        target && target.status !== 'invalid' && target.status !== 'out-of-root'
          ? target.relocatedTarget
          : entry.target

      return [
        entry.relativePath,
        entry.kind,
        isPointer(entry.relativePath) ? '' : entry.sha256,
        normalizedTarget
      ]
    })

  return sha(
    JSON.stringify({
      local: normalize('local', plan.local),
      remote: normalize('remote', plan.remote)
    })
  )
}

export async function verifyDevboxRsync(
  plan: DevboxRsyncSeedPlan,
  tracked: readonly string[],
  resolutions: ReadonlyMap<string, DevboxRsyncSide>,
  signal?: AbortSignal
): Promise<boolean> {
  const destination = await inventory(plan.destinationRoot, signal)
  const source = plan.source === 'local' ? plan.local : plan.remote
  const actual = new Map(destination.map((entry) => [entry.relativePath, entry]))
  const trackedSet = new Set(tracked)

  for (const expected of source) {
    if (filterMatches(expected.relativePath) && !trackedSet.has(expected.relativePath)) {
      continue
    }
    if (resolutions.get(expected.relativePath) === plan.destination) {
      continue
    }

    const found = actual.get(expected.relativePath)
    const contentMatches =
      expected.kind === 'symlink'
        ? found?.target === expected.target
        : isPointer(expected.relativePath) || found?.sha256 === expected.sha256
    if (!found || found.kind !== expected.kind || !contentMatches) {
      return false
    }
  }
  return true
}
