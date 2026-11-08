import { createDevboxError, type DevboxError } from '../../shared/devbox-errors'

export type DevboxGitCommand = Readonly<{ cwd: string; args: readonly string[]; stdin?: string }>
export type DevboxGitCommandResult = Readonly<{ stdout: string; stderr: string; exitCode: number }>
// oxfmt-ignore
export type DevboxGitCommandRunner = (command: DevboxGitCommand) => Promise<DevboxGitCommandResult>
// oxfmt-ignore
export type DevboxGitFileEntry = Readonly<{ path: string; kind: 'file' | 'directory' | 'symlink'; mode: number; bytes?: Uint8Array }>
// oxfmt-ignore
export type DevboxGitFileSystem = Readonly<{
  snapshot(path: string): Promise<readonly DevboxGitFileEntry[]>
  readFile(path: string): Promise<Uint8Array | undefined>
  exists(path: string): Promise<boolean>
}>
// oxfmt-ignore
export type DevboxGitInventoryRequest = Readonly<{ repositoryPath: string; runner: DevboxGitCommandRunner; fileSystem: DevboxGitFileSystem; nestedRepositoryPaths?: readonly string[] }>
// oxfmt-ignore
export type DevboxGitRef = Readonly<{ name: string; objectId: string; objectType: string; symbolicTarget?: string }>
// oxfmt-ignore
export type DevboxGitReflogEntry = Readonly<{ objectId: string; ref: string; message: string }>
// oxfmt-ignore
export type DevboxGitBlockerKind = 'git-command' | 'active-operation' | 'unresolved-index' | 'missing-object' | 'alternate-object-store' | 'lfs-state' | 'unknown-worktree-layout'
// oxfmt-ignore
export type DevboxGitInventoryBlocker = Readonly<{ path: string; kind: DevboxGitBlockerKind; remediation: string; error: DevboxError }>
// oxfmt-ignore
export type DevboxGitHead = Readonly<{ mode: 'attached' | 'detached' | 'unborn'; name?: string; objectId?: string }>
// oxfmt-ignore
export type DevboxGitObjectGraph = Readonly<{ objects: readonly string[]; reachableCommits: readonly string[]; detachedCommits: readonly string[]; missing: readonly string[] }>
// oxfmt-ignore
export type DevboxGitIndex = Readonly<{ status: string; entries: string; stagedDiff: string; conflicts: readonly string[] }>
// oxfmt-ignore
export type DevboxGitTopology = Readonly<{ shallow: string; partial: boolean; promisor: string; alternates: string; alternateFiles: readonly DevboxGitFileEntry[] }>
// oxfmt-ignore
export type DevboxGitInventory = Readonly<{
  repositoryPath: string; gitDir: string; commonDir: string; head: DevboxGitHead
  refs: readonly DevboxGitRef[]; notesRefs: readonly DevboxGitRef[]; replaceRefs: readonly DevboxGitRef[]
  reflogs: readonly DevboxGitReflogEntry[]; objectGraph: DevboxGitObjectGraph; index: DevboxGitIndex
  stashes: string; rerere: Readonly<{ config: string; files: readonly DevboxGitFileEntry[] }>
  submodules: string; linkedWorktrees: string; repositoryConfig: string; worktreeConfig: string
  hooks: readonly DevboxGitFileEntry[]; template: readonly DevboxGitFileEntry[]
  lfs: Readonly<{ config: string; files: string; state: string }>; topology: DevboxGitTopology
  nestedRepositories: readonly string[]
}>
export type DevboxGitInventoryResult =
  | { status: 'supported'; inventory: DevboxGitInventory }
  | {
      status: 'blocked'
      inventory: DevboxGitInventory
      blockers: readonly DevboxGitInventoryBlocker[]
    }
  | { status: 'failed'; error: DevboxError }

const lines = (value: string): string[] => value.split('\n').filter(Boolean)
const fields = (value: string): string[][] => lines(value).map((line) => line.split('\0'))
const ids = (value: string): string[] =>
  lines(value)
    .map((line) => line.trim().split(/\s+/, 1)[0]!)
    .filter((value) => /^[0-9a-f]{7,64}$/i.test(value))
const files = async (
  fileSystem: DevboxGitFileSystem,
  path: string | undefined
): Promise<readonly DevboxGitFileEntry[]> => (path ? fileSystem.snapshot(path) : [])
const fileText = async (fileSystem: DevboxGitFileSystem, path: string): Promise<string> =>
  new TextDecoder().decode((await fileSystem.readFile(path)) ?? new Uint8Array())
export async function inventoryDevboxGit(
  request: DevboxGitInventoryRequest
): Promise<DevboxGitInventoryResult> {
  const { repositoryPath: cwd, runner, fileSystem } = request
  const blockers: DevboxGitInventoryBlocker[] = []
  const run = async (args: readonly string[]): Promise<DevboxGitCommandResult> => {
    try {
      return await runner({ cwd, args })
    } catch {
      return { stdout: '', stderr: 'runner failed', exitCode: 1 }
    }
  }
  const required = async (args: readonly string[], path: string): Promise<string> => {
    const result = await run(args)
    if (result.exitCode !== 0) {
      blockers.push(
        block(path, 'git-command', `Make the read-only command available: git ${args.join(' ')}.`)
      )
    }
    return result.stdout
  }
  const gitDir = (await required(['rev-parse', '--git-dir'], `${cwd}/.git`)).trim()
  const commonDir = (await required(['rev-parse', '--git-common-dir'], `${cwd}/.git`)).trim()
  const top = (await required(['rev-parse', '--show-toplevel'], cwd)).trim()
  if (!gitDir || !commonDir || !top) {
    return {
      status: 'failed',
      error: createDevboxError('unknown', { context: { field: 'git-repository' } })
    }
  }
  const pathFor = async (name: string): Promise<string> =>
    (await required(['rev-parse', '--git-path', name], `${gitDir}/${name}`)).trim()
  const headName = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
  const headId = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  const refsOutput = await required(
    ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)'],
    `${gitDir}/refs`
  )
  const refs = parseRefs(refsOutput)
  const reflogOutput = await required(
    ['reflog', 'show', '--all', '--format=%H%x00%gD%x00%gs'],
    `${gitDir}/logs`
  )
  const reflogs = fields(reflogOutput).flatMap(([objectId, ref, message]) =>
    objectId && ref ? [{ objectId, ref, message: message ?? '' }] : []
  )
  const graphOutput = await required(
    ['rev-list', '--all', '--reflog', 'HEAD', '--objects', '--missing=print'],
    `${gitDir}/objects`
  )
  const missing = lines(graphOutput)
    .filter((line) => line.startsWith('?'))
    .map((line) => line.slice(1).trim())
  if (missing.length > 0) {
    blockers.push(
      block(
        `${gitDir}/objects`,
        'missing-object',
        'Materialize every missing object before handoff.'
      )
    )
  }
  const graphObjects = ids(graphOutput),
    commitOutput = await required(['rev-list', '--all', '--reflog', 'HEAD'], `${gitDir}/objects`)
  const status = await required(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
    cwd
  )
  const entries = await required(['ls-files', '--stage', '--debug', '-z'], `${gitDir}/index`)
  const stagedDiff = await required(
    ['diff', '--cached', '--raw', '-z', '--no-ext-diff'],
    `${gitDir}/index`
  )
  const conflictText = await required(['ls-files', '--unmerged', '-z'], `${gitDir}/index`)
  const conflicts = conflictText.split('\0').filter(Boolean)
  for (const conflict of conflicts) {
    blockers.push(
      block(
        `${cwd}/${conflict.split('\t').at(-1) ?? conflict}`,
        'unresolved-index',
        'Resolve index conflicts and checkpoint both sides.'
      )
    )
  }
  const stash = await required(
    ['stash', 'list', '--format=%H%x00%gd%x00%gs'],
    `${gitDir}/refs/stash`
  )
  const submodules = await required(['submodule', 'status', '--recursive'], `${cwd}/.gitmodules`)
  const worktrees = await required(['worktree', 'list', '--porcelain'], `${commonDir}/worktrees`)
  // oxfmt-ignore
  if (worktrees && !worktrees.includes('worktree ')) { blockers.push(block(`${commonDir}/worktrees`, 'unknown-worktree-layout', 'Inspect and declare the linked-worktree layout before handoff.')) }
  const repoConfig = await required(
    ['config', '--local', '--null', '--list', '--show-origin'],
    `${gitDir}/config`
  )
  const worktreeConfigResult = await run([
    'config',
    '--worktree',
    '--null',
    '--list',
    '--show-origin'
  ])
  const worktreeConfig = worktreeConfigResult.exitCode === 0 ? worktreeConfigResult.stdout : ''
  const hooksPath = await pathFor('hooks')
  const templatePath = (await run(['config', '--get', 'init.templateDir'])).stdout.trim()
  const hooks = await files(fileSystem, hooksPath)
  const template = await files(fileSystem, templatePath || undefined)
  const rrPath = await pathFor('rr-cache')
  const rerereConfig = await run(['config', '--get-regexp', '^rerere\\.']).then(
    (result) => result.stdout
  )
  const rerereFiles = await files(fileSystem, rrPath)
  const shallow = await pathFor('shallow')
  const alternates = await pathFor('objects/info/alternates')
  const alternateFiles = await files(fileSystem, alternates)
  const alternateText = await fileText(fileSystem, alternates)
  if (alternateText.trim()) {
    blockers.push(
      block(
        alternates,
        'alternate-object-store',
        'Copy alternate objects into a self-contained object store.'
      )
    )
  }
  const topologyConfig = await run([
    'config',
    '--get-regexp',
    '^(remote\\..*\\.promisor|extensions\\.partialClone)$'
  ])
  const lfsConfig = await run(['config', '--get-regexp', '^filter\\.lfs\\.'])
  const lfsResult = await run(['lfs', 'ls-files', '--long'])
  if (lfsConfig.stdout && lfsResult.exitCode !== 0) {
    blockers.push(
      block(
        `${gitDir}/config`,
        'lfs-state',
        'Install Git LFS and make every LFS object locally recoverable.'
      )
    )
  }
  const lfsState =
    lfsResult.exitCode === 0 ? 'available' : lfsConfig.stdout ? 'unavailable' : 'absent'
  const operationNames = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'BISECT_LOG'
  ]
  for (const name of operationNames) {
    const path = await pathFor(name)
    if (await fileSystem.exists(path)) {
      blockers.push(
        block(
          path,
          'active-operation',
          'Finish or abort the in-progress Git operation before handoff.'
        )
      )
    }
  }
  const inventory: DevboxGitInventory = {
    repositoryPath: cwd,
    gitDir,
    commonDir,
    head: headName
      ? { mode: 'attached', name: headName, ...(headId ? { objectId: headId } : {}) }
      : headId
        ? { mode: 'detached', objectId: headId }
        : { mode: 'unborn' },
    refs,
    notesRefs: refs.filter((ref) => ref.name.startsWith('refs/notes/')),
    replaceRefs: refs.filter((ref) => ref.name.startsWith('refs/replace/')),
    reflogs,
    objectGraph: {
      objects: graphObjects,
      reachableCommits: ids(commitOutput),
      detachedCommits: headName ? [] : headId ? [headId] : [],
      missing
    },
    index: { status, entries, stagedDiff, conflicts },
    stashes: stash,
    rerere: { config: rerereConfig, files: rerereFiles },
    submodules,
    linkedWorktrees: worktrees,
    repositoryConfig: repoConfig,
    worktreeConfig,
    hooks,
    template,
    lfs: { config: lfsConfig.stdout, files: lfsResult.stdout, state: lfsState },
    topology: {
      shallow: await fileText(fileSystem, shallow),
      partial: Boolean(topologyConfig.stdout),
      promisor: topologyConfig.stdout,
      alternates: alternateText,
      alternateFiles
    },
    nestedRepositories: [...new Set([cwd, ...(request.nestedRepositoryPaths ?? [])])]
  }
  return blockers.length > 0
    ? { status: 'blocked', inventory, blockers }
    : { status: 'supported', inventory }
}

function parseRefs(value: string): readonly DevboxGitRef[] {
  return fields(value).flatMap(([name, objectId, objectType, symbolicTarget]) =>
    name && objectId
      ? [
          {
            name,
            objectId,
            objectType: objectType ?? '',
            ...(symbolicTarget ? { symbolicTarget } : {})
          }
        ]
      : []
  )
}

function block(
  path: string,
  kind: DevboxGitBlockerKind,
  remediation: string
): DevboxGitInventoryBlocker {
  return {
    path,
    kind,
    remediation,
    error: createDevboxError('unknown', { context: { field: `${kind}:${path}` } })
  }
}
