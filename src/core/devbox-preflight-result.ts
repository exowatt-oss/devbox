import type {
  DevboxAuthorityEpoch,
  DevboxOperationEnvelope,
  DevboxProfileV1
} from '../shared/devbox-types'
import type {
  DevboxPreflightDependencies,
  DevboxPreflightBlockReason,
  DevboxPreflightCheck,
  DevboxPreflightPreview,
  DevboxPreflightResult,
  DevboxPreflightStage,
  DevboxMeasuredCapacity,
  DevboxPathIssue
} from './devbox-preflight-types'

export function finishPreflight(
  profile: DevboxProfileV1,
  deps: DevboxPreflightDependencies,
  id: string,
  startedAt: number,
  status: DevboxPreflightResult['status'],
  checks: readonly DevboxPreflightCheck[],
  stages: readonly DevboxPreflightStage[],
  issues: readonly DevboxPathIssue[],
  capacity?: DevboxMeasuredCapacity,
  blockedReason?: DevboxPreflightBlockReason
): DevboxPreflightResult {
  const now = deps.clock()
  const phase = status === 'cancelled' ? 'cancelled' : blockedReason ? 'blocked' : 'awaiting-review'
  const epoch = `preflight:${profile.id}:${id}` as DevboxAuthorityEpoch
  const connectivity: DevboxOperationEnvelope['status']['connectivity'] =
    status === 'ready' ? { state: 'online' } : { state: 'partial', reason: 'ssh' }
  const conflict: DevboxOperationEnvelope['status']['conflict'] = issues.length
    ? { state: 'present', pathCount: issues.length }
    : { state: 'none' }
  const disk: DevboxOperationEnvelope['status']['disk'] = capacity
    ? capacity.byteDeficit || capacity.inodeDeficit
      ? {
          state: 'pressure',
          freeBytes: capacity.freeBytes,
          requiredBytes: capacity.requiredBytes
        }
      : { state: 'healthy', freeBytes: capacity.freeBytes }
    : { state: 'unknown' }
  const operation: DevboxOperationEnvelope = {
    operationId: id,
    kind: 'preflight',
    phase,
    idempotencyKey: `preflight:${profile.id}`,
    cancellation:
      status === 'cancelled'
        ? { requested: true, requestedAt: now, reason: 'user' }
        : { requested: false },
    timestamps: {
      startedAt,
      updatedAt: now,
      completedAt: now
    },
    authorityEpoch: {
      epoch,
      sequence: 0,
      owner: profile.defaultAuthority,
      observedAt: startedAt,
      committedAt: startedAt
    },
    status: {
      execution: {
        side: 'remote',
        state: status === 'ready' ? 'completed' : status === 'cancelled' ? 'paused' : 'failed'
      },
      authority: {
        side: profile.defaultAuthority,
        state: 'candidate'
      },
      freshness: { state: 'unknown' },
      conflict,
      drift: { state: 'none' },
      connectivity,
      auth: { state: 'unknown' },
      disk
    }
  }
  const blockers = checks.filter((item) => item.blocking && item.status !== 'pass')

  return {
    status,
    operation,
    checks,
    stages,
    preview: buildPreview(profile, deps, id, checks),
    blockers,
    ...(blockedReason ? { blockedReason } : {}),
    ...(capacity ? { capacity } : {}),
    pathIssues: issues,
    pathSafety: issues.some((issue) => issue.severity === 'block') ? 'block' : issues.length > 0 ? 'warn' : 'pass'
  }
}

function buildPreview(
  profile: DevboxProfileV1,
  deps: DevboxPreflightDependencies,
  operationId: string,
  checks: readonly DevboxPreflightCheck[]
): DevboxPreflightPreview {
  const darwin = checks.find((check) => check.id === 'os-distro-arch')?.details?.distro === 'darwin'
  const home = `/home/${profile.sshTarget.identity.username}`
  const state = `${home}/.local/state/devbox/${profile.id}`
  const lock = deps.toolchainLock
  const downloads = lock?.artifacts.map((artifact) => ({
    artifactId: artifact.name,
    sourceUrl: artifact.sourceUrl,
    sha256: artifact.sha256,
    destination: `${state}/downloads/${artifact.name}-${artifact.version}.${operationId}`
  })) ?? [
    {
      artifactId: profile.toolchain.lockId,
      sourceUrl: 'approved-toolchain-lock',
      sha256: profile.toolchain.lockSha256,
      destination: `${state}/downloads/${profile.toolchain.lockId}.${operationId}`
    }
  ]

  return {
    writes: [
      {
        path: profile.roots.remoteRoot,
        operation: 'create',
        side: 'remote'
      },
      {
        path: state,
        operation: 'create',
        side: 'remote'
      },
      {
        path: `${state}/operations/${operationId}/manifest.json`,
        operation: 'create',
        side: 'remote'
      },
      {
        path: `${state}/backups/${operationId}`,
        operation: 'create',
        side: 'remote'
      },
      {
        path: `${state}/generations/${operationId}`,
        operation: 'create',
        side: 'remote'
      },
      {
        path: `${state}/current`,
        operation: 'rename',
        side: 'remote'
      }
    ],
    privilegedCommands: darwin
      ? [{ command: 'brew', args: ['install', 'rsync'], reason: 'only if reviewed capability repair is approved' }]
      : [
          { command: 'sudo', args: ['-n', '-v'], reason: 'one bounded authorization check for provisioning' },
          { command: 'loginctl', args: ['enable-linger', profile.sshTarget.identity.username], reason: 'durable user jobs when linger is required' },
          { command: 'sudo', args: ['apt-get', 'install', '--no-install-recommends', 'rsync', 'zstd'], reason: 'only if reviewed capability repair is approved' }
        ],
    downloads
  }
}
