import type { DevboxProfileV1 } from '../shared/devbox-types'
import { inventoryGitRoamingRoot } from './authority/devbox-git-roaming-inventory'
import type { DevboxGitRoamingHost, DevboxGitRoamingBlocker, DevboxGitRoamingInventory, DevboxGitRoamingWarning } from './authority/devbox-git-roaming-types'

export type DevboxGitRoamingPreflight = {
  status: 'ready' | 'blocked'
  local: DevboxGitRoamingInventory
  remote: DevboxGitRoamingInventory
  blockers: readonly DevboxGitRoamingBlocker[]
  informational: readonly DevboxGitRoamingBlocker[]
  warnings: readonly DevboxGitRoamingWarning[]
}

const pairBlockingCodes = new Set<DevboxGitRoamingBlocker['code']>([
  'root-mismatch',
  'missing-repository',
  'malformed-repository',
  'park-failed',
  'unpark-failed',
  'transition-blocked',
  'sync-conflict',
  'external-drift'
])

export function classifyGitRoamingPreflightFindings(findings: readonly DevboxGitRoamingBlocker[]): {
  blockers: readonly DevboxGitRoamingBlocker[]
  informational: readonly DevboxGitRoamingBlocker[]
  warnings: readonly DevboxGitRoamingWarning[]
} {
  const blockers = findings.filter((item) => pairBlockingCodes.has(item.code))
  const informational = findings.filter((item) => !pairBlockingCodes.has(item.code))
  const warnings = informational.map((item) => ({ code: 'handoff-required' as const, repository: item.repository, message: `Informational at pair time: ${item.message}` }))
  return { blockers, informational, warnings }
}

export async function runGitRoamingPreflight(profile: DevboxProfileV1, local: DevboxGitRoamingHost, remote: DevboxGitRoamingHost): Promise<DevboxGitRoamingPreflight> {
  if (!profile.gitRoaming?.enabled) {throw new Error('git roaming is disabled')}
  const [localInventory, remoteInventory] = await Promise.all([inventoryGitRoamingRoot(local, 'local'), inventoryGitRoamingRoot(remote, 'remote')])
  const allFindings: DevboxGitRoamingBlocker[] = [...localInventory.blockers, ...remoteInventory.blockers]
  if (localInventory.repositories.length === 0 || remoteInventory.repositories.length === 0) {allFindings.push({ code: 'missing-repository', message: 'At least one initialized repository must be present in each clone set.' })}
  if (localInventory.repositories.length !== remoteInventory.repositories.length || localInventory.manifestDigest !== remoteInventory.manifestDigest) {allFindings.push({ code: 'root-mismatch', message: 'Local and remote clone sets do not have the same repository manifest.' })}
  const classified = classifyGitRoamingPreflightFindings(allFindings)
  return { status: classified.blockers.length === 0 ? 'ready' : 'blocked', local: localInventory, remote: remoteInventory, ...classified }
}
