import type { DevboxProfileV1 } from '../shared/devbox-types'
import {
  errorFor,
  makeCheck,
  parseNumber,
  type DevboxPreflightExec
} from './devbox-preflight-checks'
import type {
  DevboxCapacityEstimate,
  DevboxMeasuredCapacity,
  DevboxPreflightCheck,
  DevboxPreflightDependencies,
  DevboxPreflightRunOptions
} from './devbox-preflight-types'

const GIB = 1024 ** 3

export async function runCapacityChecks(
  profile: DevboxProfileV1,
  deps: DevboxPreflightDependencies,
  options: DevboxPreflightRunOptions,
  exec: DevboxPreflightExec,
  checks: DevboxPreflightCheck[]
): Promise<DevboxMeasuredCapacity | undefined> {
  // BSD df has no GNU --output/-B1 flags. Probe the kernel once, then use
  // Python's portable disk/statvfs APIs on macOS while retaining the strict
  // GNU probes for Ubuntu (where their output is deliberately audited).
  const platform = await exec('remote', { command: 'uname', args: ['-s'] })
  const darwin = platform?.stdout.trim() === 'Darwin'
  let freeBytes: number | undefined
  let freeInodes: number | undefined
  if (darwin) {
    const portable = await exec('remote', {
      command: 'python3',
      args: ['-c', 'import os,shutil,sys; p=sys.argv[1]; print(shutil.disk_usage(p).free); print(os.statvfs(p).f_favail)', profile.roots.remoteRoot]
    })
    const values = portable?.exitCode === 0 ? portable.stdout.trim().split(/\s+/u).map(Number) : []
    freeBytes = Number.isFinite(values[0]) ? values[0] : undefined
    freeInodes = Number.isFinite(values[1]) ? values[1] : undefined
  } else {
    const bytes = await exec('remote', { command: 'df', args: ['-B1', '--output=avail', profile.roots.remoteRoot] })
    const inodes = await exec('remote', { command: 'df', args: ['--output=iavail', profile.roots.remoteRoot] })
    freeBytes = bytes?.exitCode === 0 ? parseNumber(bytes.stdout) : undefined
    freeInodes = inodes?.exitCode === 0 ? parseNumber(inodes.stdout) : undefined
  }
  const estimate =
    options.capacity ??
    (deps.capacityEstimator ? await deps.capacityEstimator().catch(() => undefined) : undefined)
  const component: DevboxCapacityEstimate = {
    leanSeedBytes: 0,
    trackedRestoreBytes: 0,
    syncStagingBytes: 0,
    runtimeGenerationBytes: 0,
    consistentWorkspaceBytes: 0,
    blockReserveBytes: 10 * GIB,
    inodeReserve: 100_000,
    ...estimate
  }
  const complete = Object.values(component).every(
    (value) => Number.isSafeInteger(value) && value >= 0
  )
  const requiredBytes =
    component.leanSeedBytes +
    component.trackedRestoreBytes +
    component.syncStagingBytes +
    component.runtimeGenerationBytes +
    component.consistentWorkspaceBytes +
    component.blockReserveBytes
  const requiredInodes = component.inodeReserve
  let capacity: DevboxMeasuredCapacity | undefined

  if (freeBytes !== undefined && freeInodes !== undefined && complete) {
    capacity = {
      ...component,
      freeBytes,
      freeInodes,
      requiredBytes,
      requiredInodes,
      byteDeficit: Math.max(0, requiredBytes - freeBytes),
      inodeDeficit: Math.max(0, requiredInodes - freeInodes)
    }
  }

  checks.push(
    makeCheck(
      'free-bytes',
      freeBytes === undefined ? 'unknown' : 'pass',
      'Ensure the remote workspace filesystem reports available bytes.',
      true,
      freeBytes === undefined ? undefined : { freeBytes },
      freeBytes === undefined ? errorFor('free-bytes') : undefined
    )
  )
  checks.push(
    makeCheck(
      'free-inodes',
      freeInodes === undefined ? 'unknown' : 'pass',
      'Ensure the remote workspace filesystem reports available inodes.',
      true,
      freeInodes === undefined ? undefined : { freeInodes },
      freeInodes === undefined ? errorFor('free-inodes') : undefined
    )
  )
  checks.push(
    makeCheck(
      'capacity',
      !capacity ? 'unknown' : capacity.byteDeficit || capacity.inodeDeficit ? 'fail' : 'pass',
      'Free the reported byte or inode deficit before pairing; no seed or provisioning write ' +
        'is permitted while capacity is short.',
      true,
      capacity
        ? {
            requiredBytes,
            requiredInodes,
            byteDeficit: capacity.byteDeficit,
            inodeDeficit: capacity.inodeDeficit
          }
        : undefined,
      !capacity
        ? errorFor('capacity')
        : capacity.byteDeficit || capacity.inodeDeficit
          ? errorFor('capacity', 'disk_pressure')
          : undefined
    )
  )

  // Soft nproc, soft nofile, hard nofile. macOS login/ssh sessions default to a
  // 256 soft file-descriptor limit with an unlimited hard limit; processes (and
  // the tmux server Devbox starts) may raise the soft limit up to the hard one,
  // so the hard limit is the real capacity on darwin.
  const limits = await exec('remote', {
    command: 'bash',
    args: ['-c', 'printf "%s\\n%s\\n%s\\n" "$(ulimit -u)" "$(ulimit -n)" "$(ulimit -Hn 2>/dev/null || echo unknown)"']
  })
  const values = limits?.stdout.trim().split(/\s+/) ?? []
  const parseLimit = (value: string | undefined, minimum: number) =>
    value === 'unlimited' ||
    (value !== undefined && /^\d+$/.test(value) && Number(value) >= minimum)
  const fileDescriptorsOk = parseLimit(values[1], 1024) || (darwin && parseLimit(values[2], 1024))
  const limitsOk =
    limits?.exitCode === 0 &&
    values.length >= 2 &&
    parseLimit(values[0], 256) &&
    fileDescriptorsOk

  checks.push(
    makeCheck(
      'ulimit',
      limitsOk ? 'pass' : limits ? 'fail' : 'unknown',
      'Raise the remote nproc and file-descriptor limits to the reviewed workload budget.',
      true,
      values.length >= 2
        ? { nproc: values[0]!, fileDescriptors: values[1]!, ...(values[2] ? { hardFileDescriptors: values[2] } : {}) }
        : undefined,
      limitsOk ? undefined : errorFor('ulimit')
    )
  )

  return capacity
}
