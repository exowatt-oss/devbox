import { describe, expect, it } from 'vitest'
import {
  inventoryDevboxGit,
  type DevboxGitCommand,
  type DevboxGitCommandResult,
  type DevboxGitFileEntry,
  type DevboxGitFileSystem,
  type DevboxGitInventoryRequest
} from './devbox-git-inventory'

const cwd = '/fixture/worktree'
const gitDir = '/fixture/worktree/.git'
const emptyResult: DevboxGitCommandResult = { stdout: '', stderr: '', exitCode: 0 }
const hook: DevboxGitFileEntry = {
  path: 'pre-commit',
  kind: 'file',
  mode: 0o755,
  bytes: new Uint8Array([1, 2])
}
const template: DevboxGitFileEntry = {
  path: 'config',
  kind: 'file',
  mode: 0o644,
  bytes: new Uint8Array([3])
}

type FixtureOptions = Readonly<{
  detached?: boolean
  staged?: boolean
  stash?: boolean
  activeOperation?: string
  conflict?: boolean
  missingObject?: boolean
  alternate?: boolean
  lfs?: boolean
  lfsConfigured?: boolean
  shallow?: boolean
  partial?: boolean
  rerere?: boolean
  nested?: boolean
}>

function fixture(
  options: FixtureOptions = {}
): DevboxGitInventoryRequest & { commands: DevboxGitCommand[] } {
  const commands: DevboxGitCommand[] = []
  const run = async (command: DevboxGitCommand): Promise<DevboxGitCommandResult> => {
    commands.push(command)
    const [subcommand, ...rest] = command.args
    if (subcommand === 'rev-parse' && rest[0] === '--git-dir') {
      return result(gitDir)
    }
    if (subcommand === 'rev-parse' && rest[0] === '--git-common-dir') {
      return result(gitDir)
    }
    if (subcommand === 'rev-parse' && rest[0] === '--show-toplevel') {
      return result(cwd)
    }
    if (subcommand === 'rev-parse' && rest[0] === '--git-path') {
      return result(`${gitDir}/${rest[1]}`)
    }
    if (subcommand === 'symbolic-ref') {
      return options.detached ? failure() : result('main')
    }
    if (subcommand === 'rev-parse' && rest[0] === '--verify') {
      return result('a'.repeat(40))
    }
    if (subcommand === 'for-each-ref') {
      return result(refs())
    }
    if (subcommand === 'reflog') {
      return result(`a${'a'.repeat(39)}\0refs/heads/main\0commit\n`)
    }
    if (subcommand === 'rev-list') {
      return result(
        options.missingObject ? `?${'b'.repeat(40)}\n` : `${'a'.repeat(40)} commit.txt\n`
      )
    }
    if (subcommand === 'status') {
      return result(
        options.staged ? '1 M. N... 100644 100644 100644 a a file.txt\n' : '# branch.head main\n'
      )
    }
    if (subcommand === 'ls-files' && rest[0] === '--stage') {
      return result('100644 a file.txt\0  size: 2\n')
    }
    if (subcommand === 'ls-files' && rest[0] === '--unmerged') {
      return result(options.conflict ? '100644 a 1\tfile.txt\0' : '')
    }
    if (subcommand === 'diff') {
      return options.staged ? result(':100644 100644 a b M\0') : result('')
    }
    if (subcommand === 'stash') {
      return options.stash ? result('a\0stash@{0}\0WIP\n') : result('')
    }
    if (subcommand === 'submodule') {
      return result('-a submodule\n')
    }
    if (subcommand === 'worktree') {
      return result('worktree /fixture/worktree\nHEAD a\nbranch refs/heads/main\n')
    }
    if (subcommand === 'config' && rest.includes('--local')) {
      return result('file:.git/config\0core.repositoryformatversion\0\n')
    }
    if (subcommand === 'config' && rest.includes('--worktree')) {
      return result('file:.git/config.worktree\0core.worktree\0\n')
    }
    if (subcommand === 'config' && rest[0] === '--get' && rest[1] === 'init.templateDir') {
      return result('/fixture/template')
    }
    if (
      subcommand === 'config' &&
      rest[0] === '--get-regexp' &&
      String(rest[1]).startsWith('^rerere')
    ) {
      return result('rerere.enabled true\n')
    }
    if (subcommand === 'config' && rest[0] === '--get-regexp') {
      return options.partial
        ? result('remote.origin.promisor true\nextensions.partialClone origin\n')
        : result(options.lfs || options.lfsConfigured ? 'filter.lfs.clean git-lfs clean\n' : '')
    }
    if (subcommand === 'lfs') {
      return options.lfs ? result('a file.txt\n') : failure()
    }
    return emptyResult
  }
  const fileSystem: DevboxGitFileSystem = {
    snapshot: async (path) =>
      path.endsWith('/hooks')
        ? [hook]
        : path.endsWith('/template')
          ? [template]
          : path.endsWith('/rr-cache') && options.rerere
            ? [template]
            : [],
    readFile: async (path) => {
      if (path.endsWith('/shallow')) {
        return options.shallow ? bytes('shallow') : bytes('')
      }
      if (path.endsWith('/alternates')) {
        return options.alternate ? bytes('/external/objects\n') : bytes('')
      }
      return bytes('')
    },
    exists: async (path) => options.activeOperation === path.split('/').at(-1)
  }
  return {
    repositoryPath: cwd,
    runner: run,
    fileSystem,
    nestedRepositoryPaths: options.nested ? ['/fixture/worktree/nested'] : [],
    commands
  }
}

function result(stdout: string): DevboxGitCommandResult {
  return { stdout, stderr: '', exitCode: 0 }
}
function failure(): DevboxGitCommandResult {
  return { stdout: '', stderr: 'unsupported', exitCode: 1 }
}
function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
function refs(): string {
  return [
    `refs/heads/main\0${'a'.repeat(40)}\0commit\0`,
    `refs/heads/peer\0${'d'.repeat(40)}\0commit\0`,
    `refs/notes/review\0${'b'.repeat(40)}\0commit\0`,
    `refs/replace/${'c'.repeat(40)}\0${'a'.repeat(40)}\0commit\0`
  ].join('\n')
}

const forbidden = new Set([
  'add',
  'apply',
  'checkout',
  'clean',
  'commit',
  'gc',
  'merge',
  'prune',
  'push',
  'reset',
  'restore',
  'write-tree'
])

describe('inventoryDevboxGit', () => {
  it('captures complete supported state using only injected dependencies', async () => {
    const request = fixture({
      staged: true,
      stash: true,
      nested: true,
      shallow: true,
      partial: true,
      lfs: true,
      rerere: true
    })
    const result = await inventoryDevboxGit(request)

    expect(result.status).toBe('supported')
    if (result.status !== 'supported') {
      return
    }
    expect(result.inventory.head).toMatchObject({ mode: 'attached', name: 'main' })
    expect(result.inventory.refs).toHaveLength(4)
    expect(result.inventory.notesRefs).toHaveLength(1)
    expect(result.inventory.replaceRefs).toHaveLength(1)
    expect(result.inventory.reflogs[0]?.ref).toBe('refs/heads/main')
    expect(result.inventory.index).toMatchObject({
      status: expect.stringContaining('1 M.'),
      stagedDiff: expect.any(String)
    })
    expect(result.inventory.stashes).toContain('stash@{0}')
    expect(result.inventory.rerere.files).toHaveLength(1)
    expect(result.inventory.submodules).toContain('submodule')
    expect(result.inventory.linkedWorktrees).toContain('worktree /fixture/worktree')
    expect(result.inventory.hooks[0]).toMatchObject({ mode: 0o755 })
    expect(result.inventory.template[0]?.bytes).toEqual(new Uint8Array([3]))
    expect(result.inventory.lfs.state).toBe('available')
    expect(result.inventory.topology).toMatchObject({ partial: true, shallow: 'shallow' })
    expect(result.inventory.nestedRepositories).toContain('/fixture/worktree/nested')
    const unsafe = request.commands.filter(({ args }) => forbidden.has(args[0] ?? ''))
    expect(unsafe).toEqual([])
  })

  it('preserves detached HEAD and records detached recovery commit', async () => {
    const result = await inventoryDevboxGit(fixture({ detached: true }))
    expect(result.status).toBe('supported')
    if (result.status !== 'supported') {
      return
    }
    expect(result.inventory.head.mode).toBe('detached')
    expect(result.inventory.objectGraph.detachedCommits).toEqual(['a'.repeat(40)])
  })

  it.each([
    ['active operation', { activeOperation: 'MERGE_HEAD' }, 'active-operation'],
    ['unresolved index', { conflict: true }, 'unresolved-index'],
    ['missing promised object', { missingObject: true }, 'missing-object'],
    ['external alternate', { alternate: true }, 'alternate-object-store'],
    ['configured LFS without the binary', { lfsConfigured: true }, 'lfs-state']
  ] as const)('returns exact blockers for %s', async (_name, options, expectedKind) => {
    const result = await inventoryDevboxGit(fixture(options))
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') {
      return
    }
    expect(result.blockers.some((item) => item.kind === expectedKind)).toBe(true)
    for (const blocker of result.blockers) {
      expect(blocker.path.length).toBeGreaterThan(0)
      expect(blocker.kind.length).toBeGreaterThan(0)
      expect(blocker.remediation.length).toBeGreaterThan(0)
      expect(blocker.error.code).toBe('unknown')
    }
  })

  it('does not execute a real process or touch a real repository path', async () => {
    const request = fixture()
    const result = await inventoryDevboxGit(request)
    expect(result.status).toBe('supported')
    expect(request.commands.every((command) => command.cwd === cwd)).toBe(true)
    expect(request.commands.every((command) => command.stdin === undefined)).toBe(true)
  })
})
