import type { DevboxProfileV1 } from '../shared/devbox-types'
import {
  DEVBOX_REQUIRED_RSYNC_OPTIONS,
  runConnectivityChecks,
  runPlatformChecks,
  runPrerequisiteChecks,
  STAGES,
  type DevboxPreflightExec
} from './devbox-preflight-checks'
import { runCapacityChecks } from './devbox-preflight-capacity'
import { runPathChecks } from './devbox-preflight-paths'
import { finishPreflight } from './devbox-preflight-result'
import type {
  DevboxPreflightBlockReason,
  DevboxPreflightCheck,
  DevboxPreflightDependencies,
  DevboxPreflightResult,
  DevboxPreflightRunOptions,
  DevboxPreflightStage,
  DevboxMeasuredCapacity,
  DevboxPathIssue
} from './devbox-preflight-types'

export type {
  DevboxCapacityEstimate,
  DevboxClock,
  DevboxExec,
  DevboxExecRequest,
  DevboxExecResult,
  DevboxInventoryEntry,
  DevboxInventoryEntryKind,
  DevboxMeasuredCapacity,
  DevboxPathIssue,
  DevboxPreflightBlockReason,
  DevboxPreflightCheck,
  DevboxPreflightCheckId,
  DevboxPreflightDependencies,
  DevboxPreflightPreview,
  DevboxPreflightResult,
  DevboxPreflightRunOptions,
  DevboxPreflightStage,
  DevboxPreviewDownload,
  DevboxPreviewPrivilege,
  DevboxPreviewWrite
} from './devbox-preflight-types'

export { DEVBOX_REQUIRED_RSYNC_OPTIONS }

export class DevboxPreflight {
  constructor(
    readonly profile: DevboxProfileV1,
    private readonly deps: DevboxPreflightDependencies
  ) {}

  async run(options: DevboxPreflightRunOptions = {}): Promise<DevboxPreflightResult> {
    const operationId = options.operationId ?? `${this.profile.id}-preflight-${this.deps.clock()}`
    const startedAt = this.deps.clock()
    const checks: DevboxPreflightCheck[] = []
    const issues: DevboxPathIssue[] = []
    const stages: DevboxPreflightStage[] = STAGES.map(([id, phase]) => ({
      id,
      phase,
      status: 'pending',
      resumable: true
    }))
    let capacity: DevboxMeasuredCapacity | undefined

    const abort = () => {
      if (options.signal?.aborted) {
        throw new Error('preflight-cancelled')
      }
    }
    const exec: DevboxPreflightExec = async (side, request) => {
      abort()
      try {
        const executor = side === 'local' ? this.deps.localExec : this.deps.remoteExec
        const result = await executor({ ...request, signal: options.signal })
        abort()
        return result
      } catch (error) {
        if (options.signal?.aborted) {
          throw error
        }
        return undefined
      }
    }
    const setStage = (index: number, status: DevboxPreflightStage['status']) => {
      stages[index] = { ...stages[index]!, status }
    }
    const step = async (index: number, action: () => Promise<void>) => {
      setStage(index, 'running')
      try {
        await action()
        setStage(index, 'completed')
      } catch (error) {
        setStage(index, options.signal?.aborted ? 'cancelled' : 'blocked')
        throw error
      }
    }

    try {
      await step(0, async () => {
        await runConnectivityChecks(this.profile, exec, checks)
      })
      await step(1, async () => {
        await runPlatformChecks(exec, checks)
      })
      await step(2, async () => {
        await runPrerequisiteChecks(this.profile, exec, checks)
      })
      await step(3, async () => {
        capacity = await runCapacityChecks(this.profile, this.deps, options, exec, checks)
      })
      await step(4, async () => {
        await runPathChecks(this.profile, exec, checks, issues)
      })
      await step(5, async () => {})
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof Error && error.message === 'preflight-cancelled')
      ) {
        return this.finish(operationId, startedAt, 'cancelled', checks, stages, issues, capacity)
      }
      if (error instanceof Error && error.message === 'unsupported-os') {
        return this.finish(
          operationId,
          startedAt,
          'blocked',
          checks,
          stages,
          issues,
          capacity,
          'unsupported-os'
        )
      }
    }

    const blockers = checks.filter((item) => item.blocking && item.status !== 'pass')
    return this.finish(
      operationId,
      startedAt,
      blockers.length ? 'blocked' : 'ready',
      checks,
      stages,
      issues,
      capacity,
      this.reason(blockers, capacity)
    )
  }

  private reason(
    blockers: readonly DevboxPreflightCheck[],
    capacity?: DevboxMeasuredCapacity
  ): DevboxPreflightBlockReason | undefined {
    if (
      blockers.some((blocker) => blocker.id === 'host-identity' && blocker.status === 'unknown')
    ) {
      return 'ssh-identity-unverified'
    }
    if (capacity?.byteDeficit && !capacity.inodeDeficit) {
      return 'byte-deficit'
    }
    if (capacity?.inodeDeficit && !capacity.byteDeficit) {
      return 'inode-deficit'
    }

    const order = [
      'ssh-reachability:ssh-unreachable',
      'host-identity:ssh-identity-mismatch',
      'os-distro-arch:unsupported-os',
      'sudo:missing-sudo',
      'systemd-user-manager:systemd-unhealthy',
      'user-linger:linger-required',
      'remote-rsync:insufficient-rsync',
      'remote-bash:missing-command',
      'remote-python3:missing-command',
      'remote-df:missing-command',
      'free-bytes:byte-deficit',
      'free-inodes:inode-deficit',
      'capacity:byte-deficit',
      'path-safety:path-conflict'
    ]
    return (
      (order
        .find((item) => blockers.some((blocker) => item.startsWith(`${blocker.id}:`)))
        ?.split(':')[1] as DevboxPreflightBlockReason | undefined) ??
      (blockers.length ? 'preflight-unknown' : undefined)
    )
  }

  private finish(
    id: string,
    startedAt: number,
    status: DevboxPreflightResult['status'],
    checks: readonly DevboxPreflightCheck[],
    stages: readonly DevboxPreflightStage[],
    issues: readonly DevboxPathIssue[],
    capacity?: DevboxMeasuredCapacity,
    blockedReason?: DevboxPreflightBlockReason
  ): DevboxPreflightResult {
    return finishPreflight(
      this.profile,
      this.deps,
      id,
      startedAt,
      status,
      checks,
      stages,
      issues,
      capacity,
      blockedReason
    )
  }
}
