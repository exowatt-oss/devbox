import { lstat, mkdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DevboxPathMapper, findDevboxCaseCollisionCandidates } from '../../core/devbox-path-mapper'
import { filterMatches } from '../../core/devbox-rsync-filter'
import { relocateDevboxRsyncPaths } from '../../core/devbox-rsync-tracked'
import { createScaleRoots, scaleProfile } from './fixture-profile'

const relativePath = (root: string, absolutePath: string): string =>
  absolutePath.slice(root.length + 1).replaceAll('\\', '/')

const pathologicalNames = (root: string): readonly string[] => [
  join(root, 'Foo.txt'),
  join(root, 'foo.txt'),
  join(root, `cafe\u0301.txt`),
  join(root, 'café.txt'),
  join(root, '⚡-emoji.txt'),
  join(root, 'אב-rtl.txt'),
  join(root, `${'x'.repeat(240)}.txt`)
]

describe('Devbox pathological path fixtures', () => {
  it('refuses local case and Unicode collisions while retaining unusual names', async () => {
    const fixture = await createScaleRoots('devbox-pathology-')
    try {
      const profile = scaleProfile(fixture.local, fixture.remote)
      const mapper = new DevboxPathMapper(profile)
      const paths = pathologicalNames(fixture.local)
      const candidates = findDevboxCaseCollisionCandidates(paths, 'local')

      expect(candidates).toEqual(
        expect.arrayContaining([
          { paths: [paths[0], paths[1]], kind: 'case' },
          { paths: [paths[2], paths[3]], kind: 'unicode-normalization' }
        ])
      )
      for (const path of paths.slice(4)) {
        expect(mapper.map(path)).toMatchObject({
          status: 'mapped',
          mappedPath: join(fixture.remote, basename(path))
        })
        expect(filterMatches(relativePath(fixture.local, path))).toBe(false)
      }

      const caseCollision = mapper.map(paths[0]!, { knownPaths: [paths[1]!] })
      const unicodeCollision = mapper.map(paths[2]!, { knownPaths: [paths[3]!] })
      expect(caseCollision).toMatchObject({ status: 'invalid', reason: 'case-collision' })
      expect(unicodeCollision).toMatchObject({ status: 'invalid', reason: 'case-collision' })
      expect(filterMatches(relativePath(fixture.local, paths[0]!))).toBe(false)
      expect(filterMatches(relativePath(fixture.local, paths[2]!))).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it('maps emoji, RTL, long components, and paths near the POSIX limit', async () => {
    const fixture = await createScaleRoots('devbox-path-length-')
    try {
      const mapper = new DevboxPathMapper(scaleProfile(fixture.local, fixture.remote))
      const nearLimit = join(
        fixture.local,
        ...Array.from(
          { length: 31 },
          (_, index) => `segment-${String(index).padStart(2, '0')}-${'x'.repeat(108)}`
        ),
        'tail.txt'
      )
      expect(Buffer.byteLength(nearLimit)).toBeGreaterThan(3_500)
      expect(Buffer.byteLength(nearLimit)).toBeLessThan(4_096)
      expect(mapper.map(nearLimit)).toMatchObject({
        status: 'mapped',
        mappedPath: join(fixture.remote, nearLimit.slice(fixture.local.length + 1))
      })
      expect(mapper.map(join(fixture.local, '⚡', 'אב', 'payload.txt'))).toMatchObject({
        status: 'mapped'
      })
      expect(filterMatches('⚡/אב/payload.txt')).toBe(false)
      expect(filterMatches('links/escape')).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it('refuses absolute links outside the enrolled root', async () => {
    const fixture = await createScaleRoots('devbox-absolute-link-')
    try {
      const mapper = new DevboxPathMapper(scaleProfile(fixture.local, fixture.remote))
      expect(mapper.relocateSymlinkTarget('/etc/passwd', 'local-to-remote')).toMatchObject({
        status: 'out-of-root'
      })
      expect(
        mapper.relocateGitWorktreePointer('gitdir: /etc/passwd\n', 'local-to-remote')
      ).toMatchObject({ status: 'out-of-root' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('refuses relative links that resolve outside the sync root', async () => {
    const fixture = await createScaleRoots('devbox-relative-link-')
    try {
      await mkdir(join(fixture.local, 'links'), { recursive: true })
      await writeFile(fixture.outside, 'must never be followed')
      const link = join(fixture.local, 'links', 'escape')
      await symlink('../../outside-secret', link)
      const profile = scaleProfile(fixture.local, fixture.remote)

      await expect(
        relocateDevboxRsyncPaths(profile, fixture.local, 'local-to-remote', undefined, false)
      ).rejects.toMatchObject({ code: 'unknown' })
      expect((await lstat(fixture.outside)).isFile()).toBe(true)
      await expect(lstat(join(fixture.remote, 'outside-secret'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('accepts nested relative links that stay inside the enrolled root', async () => {
    const fixture = await createScaleRoots('devbox-relative-nested-')
    try {
      const link = join(fixture.local, 'a', 'b', 'link')
      await mkdir(join(fixture.local, 'a', 'b'), { recursive: true })
      await symlink('../c', link)
      await expect(
        relocateDevboxRsyncPaths(
          scaleProfile(fixture.local, fixture.remote),
          fixture.local,
          'local-to-remote',
          undefined,
          false
        )
      ).resolves.toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it('refuses the explicit nested ../../../../etc/passwd relative-link shape', async () => {
    const fixture = await createScaleRoots('devbox-relative-etc-')
    try {
      const link = join(fixture.local, 'a', 'b', 'link')
      await mkdir(join(fixture.local, 'a', 'b'), { recursive: true })
      await symlink('../../../../etc/passwd', link)
      const mapper = new DevboxPathMapper(scaleProfile(fixture.local, fixture.remote))
      expect(
        mapper.relocateSymlinkTarget('../../../../etc/passwd', 'local-to-remote', {
          symlinkPath: link
        })
      ).toMatchObject({ status: 'out-of-root' })
    } finally {
      await fixture.cleanup()
    }
  })
})
