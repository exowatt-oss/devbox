import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DevboxGitRoamingHost, DevboxGitRoamingInventory, DevboxGitRoamingRepository, DevboxGitRoamingBlocker, DevboxGitRoamingSide } from './devbox-git-roaming-types'
import { DEVBOX_GIT_ROAMING_EXCLUSIONS } from '../../shared/devbox-types'

const operationNames = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']
const text = (value: string): string => value.trim()
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function safeOrigin(value: string | null): string | null {
  if (!value) {return null}
  try { const parsed = new URL(value); parsed.username = ''; parsed.password = ''; return parsed.toString() } catch { return value.includes('@') ? value.slice(value.indexOf('@') + 1) : value }
}
const blocker = (code: DevboxGitRoamingBlocker['code'], message: string, repository?: string): DevboxGitRoamingBlocker => ({ code, message, ...(repository ? { repository } : {}) })

async function has(host: DevboxGitRoamingHost, path: string): Promise<boolean> { return host.files.exists(path) }
async function mapBounded<T, R>(values: readonly T[], worker: (value: T) => Promise<R>, limit = 4): Promise<R[]> {
  const output: R[] = []; let cursor = 0
  const consume = async (): Promise<void> => { while (cursor < values.length) { const index = cursor++; output[index] = await worker(values[index]!) } }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => consume()))
  return output
}
async function run(host: DevboxGitRoamingHost, repo: string, gitPath: string, args: readonly string[]) {
  return host.run(repo, [`--git-dir=${gitPath}`, `--work-tree=${repo}`, ...args])
}
function topology(active: boolean, parked: boolean): DevboxGitRoamingRepository['topology'] {
  return active && parked ? 'mixed' : active ? 'active' : parked ? 'parked' : 'missing'
}
function excluded(path: string): boolean {
  const normalized = path.replaceAll(sep, '/')
  return DEVBOX_GIT_ROAMING_EXCLUSIONS.some((pattern) => {
    const raw = pattern.replaceAll('**/', '').replaceAll('*', '')
    return normalized === raw || normalized.startsWith(raw) || (pattern.includes('*') && normalized.endsWith(raw))
  })
}
async function trackedExcluded(host: DevboxGitRoamingHost, repo: string, gitPath: string): Promise<readonly string[]> {
  const result = await run(host, repo, gitPath, ['ls-files', '-z'])
  if (result.exitCode !== 0) {return []}
  return result.stdout.split('\0').filter(Boolean).filter(excluded)
}
async function repository(host: DevboxGitRoamingHost, root: string, relativePath: string): Promise<{ value: DevboxGitRoamingRepository; blockers: DevboxGitRoamingBlocker[] }> {
  const path = join(root, relativePath)
  const gitPath = join(path, '.git')
  const parkedPath = join(path, '.git.devbox-parked')
  const [active, parked, activeDirectory, parkedDirectory] = await Promise.all([has(host, gitPath), has(host, parkedPath), host.files.isDirectory(gitPath), host.files.isDirectory(parkedPath)])
  const blockers: DevboxGitRoamingBlocker[] = []
  const kind: DevboxGitRoamingRepository['metadataKind'] = active ? (activeDirectory ? 'directory' : 'file') : parked ? (parkedDirectory ? 'directory' : 'file') : 'missing'
  const topologyValue = topology(active, parked)
  if (topologyValue === 'mixed') {blockers.push(blocker('malformed-repository', 'Both .git and .git.devbox-parked exist; repair the topology before handoff.', relativePath))}
  const metadata = active ? gitPath : parkedPath
  const metadataText = kind === 'file' ? await host.files.readFile(metadata) : undefined
  const isSubmoduleGitfile = Boolean(metadataText?.trim().startsWith('gitdir:') && metadataText.includes('/modules/'))
  const linkedWorktree = kind === 'file' && !isSubmoduleGitfile
  if (linkedWorktree) {blockers.push(blocker('linked-worktree', 'The repository uses file-based Git metadata; linked worktrees are not supported in Phase 1.', relativePath))}
  const commandGitPath = metadataText?.trim().startsWith('gitdir:') ? resolve(dirname(metadata), metadataText.trim().slice('gitdir:'.length).trim()) : metadata
  const empty: DevboxGitRoamingRepository = { relativePath, path, gitPath, parkedPath, commandGitPath, metadataKind: kind, topology: topologyValue, branch: null, head: null, clean: false, detached: false, activeOperation: null, linkedWorktree, submoduleState: 'none', origin: null, published: false, objectReachable: false, treeFingerprint: hash(relativePath), excludedTrackedPaths: [] }
  if (!active && !parked) {return { value: empty, blockers: [...blockers, blocker('missing-repository', 'No active or parked .git metadata was found.', relativePath)] }}
  const [branchResult, headResult, statusResult] = await Promise.all([
    run(host, path, commandGitPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    run(host, path, commandGitPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    run(host, path, commandGitPath, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'])
  ])
  const branch = branchResult.exitCode === 0 ? text(branchResult.stdout) : null
  const head = headResult.exitCode === 0 ? text(headResult.stdout) : null
  const statusLines = statusResult.stdout.split('\n').filter((line) => line && !line.startsWith('#') && !line.includes('.git.devbox-parked'))
  const clean = statusResult.exitCode === 0 && statusLines.length === 0
  if (!clean) {blockers.push(blocker('dirty-repository', `Repository is dirty${statusLines[0] ? ` (${statusLines[0].slice(0, 120)})` : ''}. Commit or stash before handoff.`, relativePath))}
  if (!branch) {blockers.push(blocker('detached-head', 'Repository must have a named current branch.', relativePath))}
  const [operationPaths, worktree, modules, originResult, excludedTrackedPaths] = await Promise.all([
    Promise.all(operationNames.map(async (name) => ({ name, present: await has(host, join(commandGitPath, name)) }))),
    run(host, path, commandGitPath, ['worktree', 'list', '--porcelain']),
    run(host, path, commandGitPath, ['submodule', 'status', '--recursive']),
    run(host, path, commandGitPath, ['remote', 'get-url', 'origin']),
    trackedExcluded(host, path, commandGitPath)
  ])
  const activeOperation: string | null = operationPaths.find((item) => item.present)?.name ?? null
  if (activeOperation) {blockers.push(blocker('active-operation', `Git operation ${activeOperation} is in progress. Finish or abort it before handoff.`, relativePath))}
  const hasLinkedWorktree = worktree.exitCode === 0 && worktree.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length > 1
  if (hasLinkedWorktree) {blockers.push(blocker('linked-worktree', 'Linked worktrees are not supported by the Phase 1 profile.', relativePath))}
  const moduleLines = modules.exitCode === 0 ? modules.stdout.split('\n').filter(Boolean) : []
  const submoduleState: DevboxGitRoamingRepository['submoduleState'] = moduleLines.some((line) => line.startsWith('-')) ? 'uninitialized' : moduleLines.some((line) => line.startsWith('+') || line.startsWith('U')) ? 'inconsistent' : moduleLines.length > 0 ? 'initialized' : 'none'
  if (submoduleState === 'uninitialized') {blockers.push(blocker('uninitialized-submodule', 'Every configured submodule must be initialized on both sides.', relativePath))}
  if (submoduleState === 'inconsistent') {blockers.push(blocker('uninitialized-submodule', 'Submodule HEAD does not match the parent gitlink.', relativePath))}
  const origin = originResult.exitCode === 0 ? safeOrigin(text(originResult.stdout)) : null
  const [remote, object] = await Promise.all([
    branch && origin ? run(host, path, commandGitPath, ['ls-remote', 'origin', `refs/heads/${branch}`]) : Promise.resolve({ exitCode: 1, stdout: '', stderr: '' }),
    head ? run(host, path, commandGitPath, ['cat-file', '-e', `${head}^{commit}`]) : Promise.resolve({ exitCode: 1, stdout: '', stderr: '' })
  ])
  const published = remote.exitCode === 0 && remote.stdout.split(/\s+/u)[0] === head
  if (!published) {blockers.push(blocker('missing-origin-publication', 'Current branch HEAD is not published at origin.', relativePath))}
  const objectReachable = object.exitCode === 0
  if (!objectReachable) {blockers.push(blocker('missing-passive-object', 'Current HEAD object is not reachable in this clone.', relativePath))}
  if (excludedTrackedPaths.length) {blockers.push(blocker('excluded-tracked-path', `Tracked paths are excluded from the roaming working-tree channel: ${excludedTrackedPaths.join(', ')}`, relativePath))}
  const value: DevboxGitRoamingRepository = { ...empty, branch, head, clean, dirtyReason: clean ? undefined : statusLines[0], detached: !branch && Boolean(head), activeOperation, linkedWorktree: linkedWorktree || hasLinkedWorktree, submoduleState, origin, published, objectReachable, excludedTrackedPaths, treeFingerprint: hash(`${relativePath}\0${branch ?? ''}\0${head ?? ''}\0${statusResult.stdout}`) }
  return { value, blockers }
}

async function discover(host: DevboxGitRoamingHost, path = host.root, found = new Set<string>(), base = host.root): Promise<Set<string>> {
  const entries = await host.files.list(path)
  if (entries.some((entry) => entry.name === '.git' || entry.name === '.git.devbox-parked')) {found.add(relative(base, path) || '.')}
  await Promise.all(entries.filter((entry) => entry.directory && !['.git', '.git.devbox-parked', '.worktrees', 'node_modules'].includes(entry.name)).map((entry) => discover(host, join(path, entry.name), found, base)))
  return found
}

export async function inventoryGitRoamingRoot(host: DevboxGitRoamingHost, side: DevboxGitRoamingSide, now = Date.now): Promise<DevboxGitRoamingInventory> {
  const paths = [...await discover(host)].sort()
  // Keep one repository probe in flight per host. Each probe fans out its independent
  // read-only Git checks; opening several SSH batches at once trips remote MaxStartups.
  const results = await mapBounded(paths, (path) => repository(host, host.root, path), 1)
  const repositories = results.map((result) => result.value)
  const blockers = results.flatMap((result) => result.blockers)
  const manifestDigest = hash(JSON.stringify(repositories.map((item) => ({ path: item.relativePath, kind: item.metadataKind, branch: item.branch, head: item.head })).sort((a, b) => a.path.localeCompare(b.path))))
  return { side, root: host.root, repositories, manifestDigest, dirtyRepositories: repositories.filter((item) => !item.clean).length, unpublishedRepositories: repositories.filter((item) => !item.published).length, blockers, observedAt: now() }
}
