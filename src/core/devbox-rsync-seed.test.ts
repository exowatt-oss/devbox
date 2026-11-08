import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import {
  collectDevboxTrackedFiles,
  DEVBOX_RSYNC_LEAN_FILTER,
  RsyncSeedAndRepair,
  type DevboxRsyncExecRequest,
  type DevboxRsyncSeedDependencies
} from './devbox-rsync-seed'

const profileFor = (localRoot: string, remoteRoot: string): DevboxProfileV1 => ({
  schemaVersion: 1,
  id: 'seed-test',
  displayName: 'Seed test',
  sshTarget: {
    targetId: 'fixture',
    identity: { host: 'fixture', port: 22, username: 'tester', hostKeyFingerprint: 'SHA256:test' }
  },
  roots: { localRoot, remoteRoot },
  pathMap: [],
  toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [
      {
        id: 'working',
        kind: 'portable-working',
        backend: 'rsync-fallback',
        mode: 'two-way-safe',
        excludes: []
      }
    ],
    defaultClassId: 'working',
    excludes: []
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 5000,
    reconnectTargetMs: 15000,
    operationRecoveryTargetMs: 30000,
    offlineEdits: 'warn'
  }
})

const copyTree = async (
  source: string,
  destination: string,
  excludes: readonly string[],
  prefix = ''
): Promise<void> => {
  const info = await lstat(source)
  if (excludes.some((value) => prefix === value || prefix.startsWith(`${value}/`))) {
    return
  }
  await mkdir(dirname(destination), { recursive: true })
  if (info.isSymbolicLink()) {
    await rm(destination, { force: true, recursive: true })
    return symlink(await readlink(source), destination)
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const child of await readdir(source)) {
      await copyTree(
        join(source, child),
        join(destination, child),
        excludes,
        prefix ? `${prefix}/${child}` : child
      )
    }
    return
  }
  await copyFile(source, destination)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devbox-rsync-seed-')),
    local = join(root, 'local'),
    remote = join(root, 'remote')
  await Promise.all([mkdir(local, { recursive: true }), mkdir(remote, { recursive: true })])
  const requests: DevboxRsyncExecRequest[] = [],
    backups: string[][] = [],
    tracked = new Map<string, string>(),
    state = { failNext: false }
  const exec = async (request: DevboxRsyncExecRequest) => {
    requests.push(request)
    if (request.command === 'git') {
      return { exitCode: 0, stdout: tracked.get(request.args[1]!) ?? '', stderr: '' }
    }
    if (request.command !== 'rsync') {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (state.failNext) {
      state.failNext = false
      return { exitCode: 23, stdout: '', stderr: 'interrupted' }
    }
    const args = request.args,
      list = args.find((arg) => arg.startsWith('--files-from=')),
      endpoints = args.slice(-2),
      source = endpoints[0]!.replace(/\/$/, ''),
      destination = endpoints[1]!,
      excludes = args
        .filter((arg) => arg.startsWith('--exclude='))
        .map((arg) => arg.slice('--exclude='.length))
    await mkdir(destination, { recursive: true })
    if (list) {
      for (const value of (await readFile(list.slice('--files-from='.length)))
        .toString()
        .split('\0')
        .filter(Boolean)) {
        await copyTree(join(source, value), join(destination, value), [])
      }
    } else {
      const filterExcludes = DEVBOX_RSYNC_LEAN_FILTER.filter((rule) => rule.startsWith('- ')).map(
        (rule) => rule.slice(2).replace(/\/$/, '')
      )
      await copyTree(source, destination, [...filterExcludes, ...excludes])
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const deps: DevboxRsyncSeedDependencies = {
    exec,
    backup: async ({ paths }) => {
      backups.push([...paths])
      return join(root, `backup-${backups.length}`)
    }
  }
  return {
    root,
    local,
    remote,
    profile: profileFor(local, remote),
    requests,
    backups,
    tracked,
    state,
    seeder: new RsyncSeedAndRepair(profileFor(local, remote), deps),
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
const rsyncRequests = (requests: readonly DevboxRsyncExecRequest[]) =>
  requests.filter((request) => request.command === 'rsync')

const canonicalFilter = [
  '- node_modules/',
  '- .venv/',
  '- venv/',
  '- env/',
  '- __pycache__/',
  '- *.pyc',
  '- *.pyo',
  '- *.pyd',
  '- .pytest_cache/',
  '- .mypy_cache/',
  '- .ruff_cache/',
  '- .tox/',
  '- .nox/',
  '- .hypothesis/',
  '- .cache/',
  '- .npm/',
  '- .pnpm-store/',
  '- .yarn/cache/',
  '- .turbo/',
  '- .next/',
  '- .nuxt/',
  '- .svelte-kit/',
  '- coverage/',
  '- htmlcov/',
  '- .coverage',
  '- .coverage.*',
  '- dist/',
  '- build/',
  '- target/',
  '- out/',
  '- .parcel-cache/',
  '- .vite/',
  '- .eslintcache',
  '- *.egg-info/',
  '- .eggs/',
  '- .DS_Store',
  '- .AppleDouble/',
  '- .rsync-partial/'
]

describe('RsyncSeedAndRepair', () => {
  it('keeps exactly one canonical lean filter list', () =>
    expect([...DEVBOX_RSYNC_LEAN_FILTER]).toEqual(canonicalFilter))

  it('classifies both non-empty roots and issues no command before acceptance', async () => {
    const f = await fixture()
    try {
      await put(join(f.local, 'local-only.txt'), 'local')
      await put(join(f.remote, 'remote-only.txt'), 'remote')
      await put(join(f.local, 'divergent.txt'), 'local')
      await put(join(f.remote, 'divergent.txt'), 'remote')
      await put(join(f.local, 'remote-wins.txt'), 'local')
      await put(join(f.remote, 'remote-wins.txt'), 'remote')
      const plan = await f.seeder.createPlan(),
        classes = new Map(plan.comparisons.map((item) => [item.relativePath, item.classification]))
      expect(Object.fromEntries(classes)).toMatchObject({
        'local-only.txt': 'local-only',
        'remote-only.txt': 'remote-only',
        'divergent.txt': 'divergent-same-path',
        'remote-wins.txt': 'divergent-same-path'
      })
      const blocked = await f.seeder.seed()
      expect(blocked).toMatchObject({ status: 'blocked', reason: 'plan-required', commands: 0 })
      expect(f.requests).toHaveLength(0)
      const accepted = f.seeder.acceptPlan(plan, [
        { relativePath: 'divergent.txt', keep: 'local' },
        { relativePath: 'remote-wins.txt', keep: 'remote' }
      ])
      const result = await f.seeder.seed({ acceptance: accepted, operationId: 'accepted' })
      expect(result.status).toBe('completed')
      expect(f.backups).toHaveLength(1)
      expect(await readFile(join(f.remote, 'local-only.txt'), 'utf8')).toBe('local')
      expect(await readFile(join(f.remote, 'remote-only.txt'), 'utf8')).toBe('remote')
      expect(await readFile(join(f.remote, 'divergent.txt'), 'utf8')).toBe('local')
      expect(await readFile(join(f.local, 'remote-wins.txt'), 'utf8')).toBe('remote')
      expect(rsyncRequests(f.requests).every(({ args }) => !args.includes('--delete'))).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

  it('refuses file-directory type conflicts before rsync', async () => {
    const f = await fixture()
    try {
      await put(join(f.local, 'conflict'), 'file')
      await mkdir(join(f.remote, 'conflict'))
      const result = await f.seeder.seed({ accepted: true })
      expect(result).toMatchObject({ status: 'blocked', reason: 'type-conflict', commands: 0 })
      expect(f.requests).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })

  it('collects nested repositories and linked worktrees while skipping missing files', async () => {
    const f = await fixture()
    try {
      await put(join(f.local, '.git', 'HEAD'), 'root')
      await put(join(f.local, 'root.txt'), 'root')
      await put(join(f.local, 'nested', '.git', 'HEAD'), 'nested')
      await put(join(f.local, 'nested', 'tracked.txt'), 'nested')
      await put(join(f.local, 'linked', '.git'), 'gitdir: ../.git/worktrees/linked\n')
      await put(join(f.local, 'linked', 'linked.txt'), 'linked')
      f.tracked.set(f.local, 'root.txt\0deleted.txt\0')
      f.tracked.set(join(f.local, 'nested'), 'tracked.txt\0')
      f.tracked.set(join(f.local, 'linked'), 'linked.txt\0')
      const files = await collectDevboxTrackedFiles(f.local, {
        exec: async (request) => ({
          exitCode: 0,
          stdout: f.tracked.get(request.args[1]!) ?? '',
          stderr: ''
        })
      })
      expect(files).toEqual(['linked/linked.txt', 'nested/tracked.txt', 'root.txt'])
    } finally {
      await f.cleanup()
    }
  })

  it('restores a tracked file under a generic exclusion', async () => {
    const f = await fixture()
    try {
      await put(join(f.local, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      await put(join(f.local, 'node_modules', 'tracked.txt'), 'tracked')
      await put(join(f.local, 'node_modules', 'ignored.txt'), 'ignored')
      f.tracked.set(f.local, 'node_modules/tracked.txt\0')
      const result = await f.seeder.seed({ operationId: 'tracked' })
      expect(result.status).toBe('completed')
      expect(await readFile(join(f.remote, 'node_modules', 'tracked.txt'), 'utf8')).toBe('tracked')
      await expect(readFile(join(f.remote, 'node_modules', 'ignored.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(
        rsyncRequests(f.requests).some(({ args }) =>
          args.some((arg) => arg.startsWith('--files-from='))
        )
      ).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

  it('retries an interrupted partial transfer and makes a verified no-op second pass', async () => {
    const f = await fixture()
    try {
      await put(join(f.local, 'payload.txt'), 'payload')
      f.state.failNext = true
      const first = await f.seeder.seed({ operationId: 'resume' })
      expect(first.status).toBe('blocked')
      expect(f.requests).toHaveLength(1)
      expect(f.requests[0]!.args).toEqual(
        expect.arrayContaining(['--partial', '--partial-dir=.rsync-partial', '--protect-args'])
      )
      await expect(readFile(join(f.remote, '.devbox-baseline.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      const second = await f.seeder.seed({ operationId: 'resume' })
      expect(second.status).toBe('completed')
      const requestCount = f.requests.length
      const noop = await f.seeder.seed({ operationId: 'resume' })
      expect(noop).toMatchObject({ status: 'noop', verifiedNoop: true, commands: 0 })
      expect(f.requests).toHaveLength(requestCount)
    } finally {
      await f.cleanup()
    }
  })

  it('relocates absolute symlinks and worktree pointers through the mapper', async () => {
    const f = await fixture()
    try {
      await put(join(f.local, 'data.txt'), 'data')
      await symlink(join(f.local, 'data.txt'), join(f.local, 'absolute-link'))
      await put(
        join(f.local, 'checkout', '.git'),
        `gitdir: ${join(f.local, 'repo', '.git', 'worktrees', 'w1')}\n`
      )
      await put(
        join(f.local, 'repo', '.git', 'worktrees', 'w1', 'gitdir'),
        `${join(f.local, 'checkout')}\n`
      )
      const result = await f.seeder.seed({ operationId: 'relocate' })
      expect(result.status).toBe('completed')
      expect(await readlink(join(f.remote, 'absolute-link'))).toBe(join(f.remote, 'data.txt'))
      expect(await readFile(join(f.remote, 'checkout', '.git'), 'utf8')).toBe(
        `gitdir: ${join(f.remote, 'repo', '.git', 'worktrees', 'w1')}\n`
      )
      expect(
        await readFile(join(f.remote, 'repo', '.git', 'worktrees', 'w1', 'gitdir'), 'utf8')
      ).toBe(`${join(f.remote, 'checkout')}\n`)
    } finally {
      await f.cleanup()
    }
  })

  it('blocks byte and inode deficits independently', async () => {
    const bytes = await fixture()
    try {
      await put(join(bytes.local, 'one.txt'), 'one')
      const byteResult = await bytes.seeder.seed({
        capacity: {
          freeBytes: 1,
          freeInodes: 100,
          leanSeedBytes: 2,
          trackedRestoreBytes: 0,
          stagingBytes: 0,
          generationsBytes: 0,
          blockReserveBytes: 0,
          inodeReserve: 0
        }
      })
      expect(byteResult).toMatchObject({ status: 'blocked', reason: 'byte-deficit' })
    } finally {
      await bytes.cleanup()
    }
    const inodes = await fixture()
    try {
      await put(join(inodes.local, 'one.txt'), 'one')
      const inodeResult = await inodes.seeder.seed({
        capacity: {
          freeBytes: 100,
          freeInodes: 0,
          leanSeedBytes: 0,
          trackedRestoreBytes: 0,
          stagingBytes: 0,
          generationsBytes: 0,
          blockReserveBytes: 0,
          inodeReserve: 1
        }
      })
      expect(inodeResult).toMatchObject({ status: 'blocked', reason: 'inode-deficit' })
    } finally {
      await inodes.cleanup()
    }
  })
})
