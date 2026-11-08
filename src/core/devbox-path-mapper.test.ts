import { describe, expect, it } from 'vitest'
import { DevboxPathMapper, findDevboxCaseCollisionCandidates } from './devbox-path-mapper'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'main',
  displayName: 'Main',
  sshTarget: {
    targetId: 'main-sample-devbox',
    identity: {
      host: 'devbox.example',
      port: 22,
      username: 'sample',
      hostKeyFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789'
    }
  },
  roots: { localRoot: '/Users/x/project', remoteRoot: '/home/sample/project' },
  pathMap: [
    {
      id: 'portable-config',
      localRelativePath: '.pi/config',
      remoteRelativePath: '.config/phi',
      syncClassId: 'portable-declarative'
    }
  ],
  toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [
      {
        id: 'portable-working',
        kind: 'portable-working',
        backend: 'mutagen',
        mode: 'two-way-safe',
        excludes: []
      },
      {
        id: 'portable-declarative',
        kind: 'portable-declarative',
        backend: 'mutagen',
        mode: 'two-way-safe',
        excludes: []
      }
    ],
    defaultClassId: 'portable-working',
    excludes: []
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 5_000,
    reconnectTargetMs: 15_000,
    operationRecoveryTargetMs: 30_000,
    offlineEdits: 'warn'
  }
}

const mapper = new DevboxPathMapper(profile)

function mapped(result: ReturnType<DevboxPathMapper['map']>): string {
  expect(result.status).toBe('mapped')
  if (result.status !== 'mapped') {
    throw new Error('expected a mapped result')
  }
  return result.mappedPath
}

describe('DevboxPathMapper', () => {
  it('requires a path boundary when mapping roots', () => {
    const result = mapper.map('/Users/x/project-old/src/index.ts')
    expect(result.status).toBe('outside-root')
    if (result.status !== 'outside-root') {
      throw new Error('expected outside-root')
    }
    expect(result.error.code).toBe('unknown')
  })

  it('maps local paths to remote and unmaps them in the reverse direction', () => {
    const local = '/Users/x/project/packages/worker.ts'
    expect(mapped(mapper.map(local))).toBe('/home/sample/project/packages/worker.ts')
    expect(mapped(mapper.unmap('/home/sample/project/packages/worker.ts'))).toBe(local)
  })

  it('uses the most specific explicit path-map entry and maps it back', () => {
    const remote = mapped(mapper.map('/Users/x/project/.pi/config/settings.json'))
    expect(remote).toBe('/home/sample/project/.config/phi/settings.json')
    expect(mapper.unmap(remote)).toMatchObject({
      status: 'mapped',
      mappedPath: '/Users/x/project/.pi/config/settings.json',
      pathMapId: 'portable-config',
      syncClassId: 'portable-declarative'
    })
  })

  it('reports a requested class that cannot own an explicitly mapped path', () => {
    const result = mapper.map('/Users/x/project/.pi/config/settings.json', {
      syncClassId: 'portable-working'
    })
    expect(result.status).toBe('unmapped-path-class')
  })

  it('refuses an absolute symlink target outside the source root', () => {
    const result = mapper.relocateSymlinkTarget('/Users/x/private/key', 'local-to-remote')
    expect(result.status).toBe('out-of-root')
    if (result.status !== 'out-of-root') {
      throw new Error('expected out-of-root')
    }
    expect(result.error.code).toBe('unknown')
  })

  it('rewrites an absolute in-root symlink target without filesystem access', () => {
    expect(mapper.relocateSymlinkTarget('/Users/x/project/assets/data', 'local-to-remote')).toEqual(
      {
        status: 'absolute-in-root',
        target: '/Users/x/project/assets/data',
        relocatedTarget: '/home/sample/project/assets/data'
      }
    )
  })

  it('refuses relative symlink targets that normalize outside the sync root', () => {
    for (const target of ['../../outside-secret', '../../etc/passwd/']) {
      expect(mapper.relocateSymlinkTarget(target, 'local-to-remote')).toMatchObject({
        status: 'out-of-root',
        target,
        error: { code: 'unknown', context: { field: 'path-outside-root' } }
      })
    }
  })

  it('preserves in-root upward relative symlink targets byte-for-byte', () => {
    const target = 'a/b/../shared/file/'
    expect(mapper.relocateSymlinkTarget(target, 'local-to-remote')).toEqual({
      status: 'relative-in-root',
      target,
      relocatedTarget: target
    })
  })

  it('keeps relative upward traversal fail-closed without a symlink path', () => {
    expect(mapper.relocateSymlinkTarget('../c', 'local-to-remote')).toMatchObject({
      status: 'out-of-root',
      error: { context: { field: 'path-outside-root' } }
    })
  })

  it('resolves a nested relative target from the symlink directory', () => {
    const symlinkPath = '/Users/x/project/local/a/b/link'
    expect(mapper.relocateSymlinkTarget('../c', 'local-to-remote', { symlinkPath })).toMatchObject({
      status: 'relative-in-root',
      target: '../c',
      relocatedTarget: '../c'
    })
  })

  it('accepts same-directory links and the sync-root boundary', () => {
    expect(
      mapper.relocateSymlinkTarget('sibling', 'local-to-remote', {
        symlinkPath: '/Users/x/project/local/a/link'
      })
    ).toMatchObject({ status: 'relative-in-root', relocatedTarget: 'sibling' })
    expect(
      mapper.relocateSymlinkTarget('../../../', 'local-to-remote', {
        symlinkPath: '/Users/x/project/local/a/b/link'
      })
    ).toMatchObject({ status: 'relative-in-root', relocatedTarget: '../../../' })
  })

  it('allows traversal up to the containing directory depth', () => {
    const root = '/Users/x/project'
    for (const [relativePath, target] of [
      ['local/link', '../at-root'],
      ['local/a/link', '../../at-root'],
      ['local/a/b/link', '../../../at-root']
    ]) {
      expect(
        mapper.relocateSymlinkTarget(target, 'local-to-remote', {
          symlinkPath: `${root}/${relativePath}`
        })
      ).toMatchObject({ status: 'relative-in-root', target, relocatedTarget: target })
    }
  })

  it('refuses a nested relative target that escapes the sync root', () => {
    const target = '../../../../etc/passwd'
    expect(
      mapper.relocateSymlinkTarget(target, 'local-to-remote', {
        symlinkPath: '/Users/x/project/local/a/b/link'
      })
    ).toMatchObject({
      status: 'out-of-root',
      target,
      error: { context: { field: 'path-outside-root' } }
    })
  })

  it('rewrites an absolute git worktree pointer and preserves its newline', () => {
    const content = 'gitdir: /Users/x/project/.git/worktrees/feature\n'
    expect(mapper.relocateGitWorktreePointer(content, 'local-to-remote')).toEqual({
      status: 'absolute-in-root',
      content,
      relocatedContent: 'gitdir: /home/sample/project/.git/worktrees/feature\n'
    })
  })

  it('preserves relative git worktree pointers and refuses unknown formats', () => {
    expect(
      mapper.relocateGitWorktreePointer(
        'gitdir: ../main/.git/worktrees/feature\n',
        'local-to-remote'
      )
    ).toMatchObject({
      status: 'relative-in-root',
      relocatedContent: 'gitdir: ../main/.git/worktrees/feature\n'
    })
    const unknown = mapper.relocateGitWorktreePointer('not-a-git-pointer\n', 'local-to-remote')
    expect(unknown.status).toBe('invalid')
    if (unknown.status !== 'invalid') {
      throw new Error('expected invalid pointer')
    }
    expect(unknown.error.code).toBe('unknown')
  })

  it('detects case-collision candidates before mapping a local inventory', () => {
    const first = '/Users/x/project/src/Readme.md'
    const second = '/Users/x/project/src/README.md'
    expect(findDevboxCaseCollisionCandidates([first, second])).toEqual([
      { paths: [first, second], kind: 'case' }
    ])
    const result = mapper.map(first, { knownPaths: [second] })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') {
      throw new Error('expected case collision')
    }
    expect(result.reason).toBe('case-collision')
    expect(result.error.code).toBe('operation_conflict')
  })

  it('detects NFC/NFD-equivalent names as Unicode collision candidates', () => {
    const decomposed = '/Users/x/project/cafe\u0301.txt'
    const composed = '/Users/x/project/caf\u00e9.txt'
    expect(findDevboxCaseCollisionCandidates([decomposed, composed])).toEqual([
      { paths: [decomposed, composed], kind: 'unicode-normalization' }
    ])
    const result = mapper.map(decomposed, { knownPaths: [composed] })
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') {
      throw new Error('expected Unicode collision')
    }
    expect(result.reason).toBe('case-collision')
  })

  it('keeps spaces and newlines in path components', () => {
    const path = '/Users/x/project/a file\nwith spaces.txt'
    expect(mapped(mapper.map(path))).toBe('/home/sample/project/a file\nwith spaces.txt')
  })
})
