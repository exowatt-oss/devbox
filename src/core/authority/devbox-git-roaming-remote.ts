import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DevboxGitRoamingHost, DevboxGitRoamingMarker, DevboxGitRoamingRepository, DevboxGitRoamingSide, DevboxGitRoamingWarning } from './devbox-git-roaming-types'

const unsigned = (marker: DevboxGitRoamingMarker): Omit<DevboxGitRoamingMarker, 'checksum'> => {
  const { checksum: _checksum, ...value } = marker
  void _checksum
  return value
}
export function checksumDevboxGitRoamingMarker(marker: Omit<DevboxGitRoamingMarker, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(marker)).digest('hex')
}
export function makeDevboxGitRoamingMarker(input: Omit<DevboxGitRoamingMarker, 'checksum'>): DevboxGitRoamingMarker {
  return { ...input, checksum: checksumDevboxGitRoamingMarker(input) }
}
export function validateDevboxGitRoamingMarker(value: unknown): value is DevboxGitRoamingMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {return false}
  const marker = value as Partial<DevboxGitRoamingMarker>
  return marker.schemaVersion === 1 && typeof marker.profileId === 'string' && marker.profileId.length > 0 && (marker.owner === 'local' || marker.owner === 'remote') && typeof marker.epoch === 'string' && Number.isSafeInteger(marker.epochSequence) && typeof marker.transitionId === 'string' && typeof marker.manifestDigest === 'string' && Number.isSafeInteger(marker.updatedAt) && typeof marker.checksum === 'string' && marker.checksum === checksumDevboxGitRoamingMarker(unsigned(value as DevboxGitRoamingMarker))
}
export function createFileGitRoamingMarkerStore(path: string) {
  return {
    async read(): Promise<DevboxGitRoamingMarker | undefined> {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (!validateDevboxGitRoamingMarker(parsed)) {throw new Error('marker checksum invalid')}
        return parsed
      } catch { return undefined }
    },
    async write(marker: DevboxGitRoamingMarker): Promise<void> {
      if (!validateDevboxGitRoamingMarker(marker)) {throw new Error('invalid git roaming marker')}
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    }
  }
}
export function createHostGitRoamingMarkerStore(host: DevboxGitRoamingHost, path: string) {
  return {
    async read(): Promise<DevboxGitRoamingMarker | undefined> {
      const raw = await host.files.readFile(path)
      if (!raw) {return undefined}
      try { const parsed: unknown = JSON.parse(raw); return validateDevboxGitRoamingMarker(parsed) ? parsed : undefined } catch { return undefined }
    },
    async write(marker: DevboxGitRoamingMarker): Promise<void> {
      if (!validateDevboxGitRoamingMarker(marker)) {throw new Error('invalid git roaming marker')}
      await host.files.writeFile(path, `${JSON.stringify(marker, null, 2)}\n`)
    }
  }
}
export async function refreshOriginForRepositories(host: DevboxGitRoamingHost, repositories: readonly DevboxGitRoamingRepository[], side: DevboxGitRoamingSide): Promise<readonly DevboxGitRoamingWarning[]> {
  const warnings: DevboxGitRoamingWarning[] = []
  for (const repo of repositories) {
    if (!repo.origin) {
      warnings.push({
        code: 'origin-missing',
        side,
        repository: repo.relativePath,
        message: `Pair-time passive refresh skipped ${side}/${repo.relativePath}: repository has no origin; handoff still requires a published origin.`
      })
      continue
    }
    const gitPath = repo.parkedPath
    const result = await host.run(repo.path, [`--git-dir=${gitPath}`, `--work-tree=${repo.path}`, 'fetch', '--prune', '--tags', 'origin'])
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim() || `git fetch exited with ${result.exitCode}`
      warnings.push({
        code: 'fetch-failed',
        side,
        repository: repo.relativePath,
        stderr,
        message: `Pair-time passive refresh failed for ${side}/${repo.relativePath}: ${stderr}`
      })
      continue
    }
    if (repo.branch && repo.head) {
      const present = await host.run(repo.path, [`--git-dir=${gitPath}`, `--work-tree=${repo.path}`, 'cat-file', '-e', `${repo.head}^{commit}`])
      if (present.exitCode !== 0) {
        const stderr = present.stderr.trim() || `git cat-file exited with ${present.exitCode}`
        warnings.push({
          code: 'passive-object-missing',
          side,
          repository: repo.relativePath,
          stderr,
          message: `Pair-time passive refresh could not verify ${side}/${repo.relativePath} HEAD ${repo.head}: ${stderr}`
        })
      }
    }
  }
  return warnings
}
