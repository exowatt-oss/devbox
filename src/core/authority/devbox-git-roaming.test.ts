import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalGitRoamingHost } from './devbox-git-roaming-host'
import { refreshOriginForRepositories } from './devbox-git-roaming-remote'
import { DevboxGitRoamingController } from './devbox-git-roaming'
import type { DevboxGitRoamingConfig } from '../../shared/devbox-types'

const config: DevboxGitRoamingConfig = { enabled: true, topology: 'working-tree-only', authorityScope: 'profile', parkedGitName: '.git.devbox-parked', refreshStrategy: 'origin', requireCleanHandoff: true, requirePublishedHead: true, excludeWorktrees: true, ignorePatterns: [] }
function command(command: string, cwd: string, ...args: string[]): string { return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim() }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devbox-git-roaming-')), origin = join(root, 'origin.git'), local = join(root, 'local'), remote = join(root, 'remote')
  execFileSync('git', ['init', '--bare', origin], { encoding: 'utf8' })
  execFileSync('git', ['init', local], { encoding: 'utf8' }); command('git', local, 'config', 'user.email', 'fixture@example.test'); command('git', local, 'config', 'user.name', 'Fixture'); writeFileSync(join(local, 'tracked.txt'), 'one\n'); command('git', local, 'add', 'tracked.txt'); command('git', local, 'commit', '-m', 'base'); command('git', local, 'branch', '-M', 'main'); command('git', local, 'remote', 'add', 'origin', origin); command('git', local, 'push', '-u', 'origin', 'main'); command('git', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'); execFileSync('git', ['clone', origin, remote], { encoding: 'utf8' }); command('git', remote, 'config', 'user.email', 'fixture@example.test'); command('git', remote, 'config', 'user.name', 'Fixture')
  return { root, origin, local, remote }
}

describe('DevboxGitRoamingController', { timeout: 120_000 }, () => {
  it('parks the passive clone, permits passive reads, and hands off published metadata', async () => {
    const f = fixture()
    const controller = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, refresh: async (side, repos) => refreshOriginForRepositories(side === 'local' ? createLocalGitRoamingHost(f.local) : createLocalGitRoamingHost(f.remote), repos, side) })
    await controller.initialize()
    expect(existsSync(join(f.remote, '.git'))).toBe(false)
    expect(existsSync(join(f.remote, '.git.devbox-parked'))).toBe(true)
    await expect(controller.runGit('remote', f.remote, ['status'])).resolves.toMatchObject({ passive: true, exitCode: 0 })
    await expect(controller.runGit('remote', f.remote, ['commit', '-am', 'bad'])).rejects.toMatchObject({ context: { field: 'git-authority' } })
    const result = await controller.handoff('remote')
    expect(result.status).toBe('committed')
    expect(existsSync(join(f.local, '.git.devbox-parked'))).toBe(true)
    expect(existsSync(join(f.remote, '.git'))).toBe(true)
    expect(command('git', f.remote, 'branch', '--show-current')).toBe('main')
    const status = await controller.status()
    expect(status.owner).toBe('remote')
    expect(status.localGit).toBe('parked')
    expect(status.remoteGit).toBe('active')
    expect(status.witnesses).toBe('agree')
  })

  it('uses the non-terminating flush, pause, verify, resume barrier order', async () => {
    const f = fixture(); const eventsList: string[] = []
    const controller = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, refresh: async () => undefined, supervisor: { flush: async () => { eventsList.push('flush') }, verify: async () => { eventsList.push('verify'); return { conflictCount: 0, fresh: true } }, pause: async () => { eventsList.push('pause') }, resume: async () => { eventsList.push('resume') } } })
    await controller.initialize(); expect((await controller.handoff('remote')).status).toBe('committed')
    expect(eventsList).toEqual(['flush', 'pause', 'verify', 'resume'])
  })

  it('refuses dirty and detached authorities without changing topology', async () => {
    const f = fixture()
    const controller = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root })
    await controller.initialize(); writeFileSync(join(f.local, 'tracked.txt'), 'dirty\n')
    const dirty = await controller.handoff('remote')
    expect(dirty.status).toBe('blocked')
    expect(dirty.blockers.some((item) => item.code === 'dirty-repository')).toBe(true)
    expect(existsSync(join(f.local, '.git'))).toBe(true)
    expect(existsSync(join(f.remote, '.git.devbox-parked'))).toBe(true)
  })

  it('recovers an interrupted candidate by restoring old authority', async () => {
    const f = fixture()
    const interrupted = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, failureStage: 'reconciling' })
    await interrupted.initialize()
    expect((await interrupted.handoff('remote')).status).toBe('blocked')
    const recovered = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root })
    expect((await recovered.status()).owner).toBe('local')
    expect(existsSync(join(f.local, '.git'))).toBe(true)
    expect(existsSync(join(f.remote, '.git.devbox-parked'))).toBe(true)
  })

  it('keeps the candidate owner after a post-commit interruption', async () => {
    const f = fixture()
    const interrupted = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, failureStage: 'committed' })
    await interrupted.initialize(); expect((await interrupted.handoff('remote')).status).toBe('blocked')
    const recovered = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root })
    const status = await recovered.status()
    expect(status.owner).toBe('remote'); expect(status.transition).toBe('idle'); expect(existsSync(join(f.remote, '.git'))).toBe(true); expect(existsSync(join(f.local, '.git.devbox-parked'))).toBe(true)
  })

  it('keeps pair-time origin refresh warnings named and non-fatal', async () => {
    const f = fixture()
    const controller = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, refresh: async () => [{ code: 'origin-missing', side: 'remote', repository: '.', message: 'Pair-time passive refresh skipped remote/.: repository has no origin; handoff still requires a published origin.' }] })
    await controller.initialize()
    const status = await controller.status()
    expect(status.transition).toBe('idle')
    expect(status.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'origin-missing', repository: '.' })]))
    expect(existsSync(join(f.remote, '.git.devbox-parked'))).toBe(true)
  })

  it('recovers all parked metadata after pair initialization interruption', async () => {
    const f = fixture()
    const interrupted = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, failureStage: 'candidate' })
    await expect(interrupted.initialize()).rejects.toThrow('pair initialization interruption')
    const recovered = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root })
    const status = await recovered.status()
    expect(status.transition).toBe('idle')
    expect(existsSync(join(f.local, '.git'))).toBe(true)
    expect(existsSync(join(f.remote, '.git'))).toBe(true)
    expect(existsSync(join(f.remote, '.git.devbox-parked'))).toBe(false)
  })

  it('skips origin-less repositories without invoking fetch', async () => {
    const f = fixture()
    const host = createLocalGitRoamingHost(f.remote)
    const inventory = await new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: host, stateRoot: f.root }).inventory('remote')
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const warnings = await refreshOriginForRepositories({ ...host, run: runner }, [{ ...inventory.repositories[0]!, origin: null }], 'remote')
    expect(runner).not.toHaveBeenCalled()
    expect(warnings).toEqual([expect.objectContaining({ code: 'origin-missing', side: 'remote', repository: '.' })])
  })

  it('surfaces actual fetch stderr instead of an offline error', async () => {
    const f = fixture()
    const host = createLocalGitRoamingHost(f.remote)
    const inventory = await new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: host, stateRoot: f.root }).inventory('remote')
    const runner = vi.fn(async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: repository unavailable' }))
    const warnings = await refreshOriginForRepositories({ ...host, run: runner }, [inventory.repositories[0]!], 'remote')
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'fetch-failed', repository: '.', message: expect.stringContaining('repository unavailable'), stderr: 'fatal: repository unavailable' })]))
  })

  it('rejects a checksum-tampered peer marker', async () => {
    const f = fixture(); const marker = join(f.root, 'marker.json')
    writeFileSync(marker, JSON.stringify({ schemaVersion: 1, profileId: 'fixture', epochSequence: 0, epoch: 'initial:fixture', owner: 'local', transitionId: 'initial:fixture', stage: 'committed', manifestDigest: 'x', updatedAt: 1, checksum: 'tampered' }))
    const controller = new DevboxGitRoamingController({ profileId: 'fixture', config, local: createLocalGitRoamingHost(f.local), remote: createLocalGitRoamingHost(f.remote), stateRoot: f.root, marker: { read: async () => undefined, write: async () => undefined } })
    expect((await controller.status()).witnesses).toBe('missing')
    expect(readFileSync(marker, 'utf8')).toContain('tampered')
  })
})
