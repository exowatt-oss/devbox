import { join } from 'node:path'
import type { DevboxGitRoamingHost, DevboxGitRoamingRepository, DevboxGitRoamingSide, DevboxGitRoamingBlocker } from './devbox-git-roaming-types'

export type DevboxGitRoamingTopologyRecord = {
  profileId: string
  transitionId: string
  side: DevboxGitRoamingSide
  relativePath: string
  from: 'active' | 'parked'
  to: 'active' | 'parked'
  completed: boolean
  updatedAt: number
}
export type DevboxGitRoamingRecordStore = {
  read(relativePath: string, side: DevboxGitRoamingSide): Promise<DevboxGitRoamingTopologyRecord | undefined>
  write(record: DevboxGitRoamingTopologyRecord): Promise<void>
}

export function createMemoryTopologyRecords(): DevboxGitRoamingRecordStore {
  const records = new Map<string, DevboxGitRoamingTopologyRecord>()
  return {
    async read(path, side) { return records.get(`${side}:${path}`) },
    async write(record) { records.set(`${record.side}:${record.relativePath}`, record) }
  }
}

export function createFileTopologyRecords(files: DevboxGitRoamingHost['files'], root: string): DevboxGitRoamingRecordStore {
  const pathFor = (side: DevboxGitRoamingSide, relativePath: string): string => join(root, `${side}-${encodeURIComponent(relativePath)}.json`)
  return {
    async read(relativePath, side) {
      const raw = await files.readFile(pathFor(side, relativePath))
      if (!raw) {return undefined}
      try { return JSON.parse(raw) as DevboxGitRoamingTopologyRecord } catch { return undefined }
    },
    async write(record) { await files.writeFile(pathFor(record.side, record.relativePath), `${JSON.stringify(record)}\n`) }
  }
}

async function renameMetadata(host: DevboxGitRoamingHost, repo: DevboxGitRoamingRepository, active: boolean): Promise<void> {
  const source = active ? repo.parkedPath : repo.gitPath
  const target = active ? repo.gitPath : repo.parkedPath
  const sourceExists = await host.files.exists(source)
  const targetExists = await host.files.exists(target)
  if (targetExists && sourceExists) {throw new Error(`mixed_git_topology:${repo.relativePath}`)}
  if (!sourceExists) {
    if (targetExists) {return}
    throw new Error(`missing_git_metadata:${repo.relativePath}`)
  }
  await host.files.rename(source, target)
  await host.files.syncDirectory(repo.path)
}

export async function setRepositoryTopology(
  host: DevboxGitRoamingHost,
  repo: DevboxGitRoamingRepository,
  side: DevboxGitRoamingSide,
  active: boolean,
  transitionId: string,
  now: () => number,
  records: DevboxGitRoamingRecordStore,
  beforeRename?: (record: DevboxGitRoamingTopologyRecord) => void
): Promise<void> {
  const current = active ? 'parked' : 'active'
  const target = active ? 'active' : 'parked'
  const record: DevboxGitRoamingTopologyRecord = { profileId: '', transitionId, side, relativePath: repo.relativePath, from: current, to: target, completed: false, updatedAt: now() }
  await records.write(record)
  beforeRename?.(record)
  await renameMetadata(host, repo, active)
  await records.write({ ...record, completed: true, updatedAt: now() })
}

export async function setRootTopology(
  host: DevboxGitRoamingHost,
  repositories: readonly DevboxGitRoamingRepository[],
  side: DevboxGitRoamingSide,
  active: boolean,
  transitionId: string,
  now: () => number,
  records: DevboxGitRoamingRecordStore,
  beforeRename?: (record: DevboxGitRoamingTopologyRecord) => void
): Promise<readonly DevboxGitRoamingBlocker[]> {
  const blockers: DevboxGitRoamingBlocker[] = []
  for (const repo of [...repositories].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    try { await setRepositoryTopology(host, repo, side, active, transitionId, now, records, beforeRename) }
    catch (error) { blockers.push({ code: active ? 'unpark-failed' : 'park-failed', message: error instanceof Error ? error.message : String(error), repository: repo.relativePath }); break }
  }
  return blockers
}

export function topologyState(root: string, repo: DevboxGitRoamingRepository): string {
  return join(root, repo.relativePath, '.git')
}
