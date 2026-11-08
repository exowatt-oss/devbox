import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevboxSyncBackend, DevboxSyncConflict } from './devbox-sync-backend'
import {
  DevboxWorkspaceGenerationManager,
  type DevboxWorkspaceGenerationStage
} from './devbox-workspace-generation-manager'

class FakeSync implements Pick<DevboxSyncBackend, 'flush' | 'pause' | 'resume' | 'listConflicts'> {
  calls: string[] = []
  conflicts: DevboxSyncConflict[] = []
  async flush(): Promise<void> {
    this.calls.push('flush')
  }
  async pause(): Promise<void> {
    this.calls.push('pause')
  }
  async resume(): Promise<void> {
    this.calls.push('resume')
  }
  async listConflicts(): Promise<readonly DevboxSyncConflict[]> {
    this.calls.push('conflicts')
    return this.conflicts
  }
}
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devbox-generation-'))
  roots.push(root)
  const source = join(root, 'live')
  const generations = join(root, 'generations')
  await mkdir(join(source, 'src'), { recursive: true })
  await writeFile(join(source, 'src', 'main.ts'), 'export const value = 1\n')
  return { source, generations }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DevboxWorkspaceGenerationManager', () => {
  it('flushes, pauses, snapshots a verified whole-tree manifest, then resumes', async () => {
    const { source, generations } = await fixture()
    const sync = new FakeSync()
    const manager = new DevboxWorkspaceGenerationManager({
      sourceRoot: source,
      generationsRoot: generations,
      sync,
      now: () => 100,
      maxRetainedGenerations: 2
    })
    const generation = await manager.createGeneration({ leaseOwnerId: 'job-1' })
    expect(sync.calls.slice(0, 4)).toEqual(['resume', 'flush', 'pause', 'conflicts'])
    expect(sync.calls.at(-1)).toBe('resume')
    expect(await manager.verifyGeneration(generation.id)).toBe(true)
    expect(generation.manifest.entries.map((entry) => entry.path)).toContain('src/main.ts')
    expect(await readFile(join(generation.root, 'src/main.ts'), 'utf8')).toContain('value = 1')
    await writeFile(join(source, 'src', 'main.ts'), 'changed\n')
    expect(await readFile(join(generation.root, 'src/main.ts'), 'utf8')).toContain('value = 1')
    await generation.lease?.release()
  })

  it('blocks conflicts and resumes the live mirror without creating a generation', async () => {
    const { source, generations } = await fixture()
    const sync = new FakeSync()
    sync.conflicts.push({
      conflictId: 'c1',
      path: 'src/main.ts',
      class: 'content',
      local: { kind: 'file', hash: 'a' },
      remote: { kind: 'file', hash: 'b' }
    })
    const manager = new DevboxWorkspaceGenerationManager({
      sourceRoot: source,
      generationsRoot: generations,
      sync
    })
    await expect(manager.createGeneration()).rejects.toMatchObject({ code: 'operation_conflict' })
    expect(sync.calls).toEqual(['resume', 'flush', 'pause', 'conflicts', 'resume'])
    expect(await manager.listGenerations()).toHaveLength(0)
  })

  it.each<DevboxWorkspaceGenerationStage>([
    'flushing',
    'pausing',
    'verifying-conflicts',
    'manifesting',
    'copying',
    'verifying-generation',
    'resuming'
  ])('recovers an interruption at %s without exposing a half-generation', async (failedStage) => {
    const { source, generations } = await fixture()
    const sync = new FakeSync()
    let failed = false
    const manager = new DevboxWorkspaceGenerationManager({
      sourceRoot: source,
      generationsRoot: generations,
      sync,
      beforeStage: async (stage) => {
        if (stage === failedStage && !failed) {
          failed = true
          throw new Error(`interrupt:${stage}`)
        }
      }
    })
    await expect(manager.createGeneration()).rejects.toThrow(`interrupt:${failedStage}`)
    const generationsAfter = await manager.listGenerations()
    for (const generation of generationsAfter) {
      expect(await manager.verifyGeneration(generation.id)).toBe(true)
    }
    expect(sync.calls.at(-1)).toBe('resume')
    expect((await readdir(generations)).some((name) => name.startsWith('.staging-'))).toBe(false)
    expect(manager.status().liveSyncResumable).toBe(true)
  })

  it('does not prune a leased generation and keeps at least one copy', async () => {
    const { source, generations } = await fixture()
    let clock = 1
    const sync = new FakeSync()
    const manager = new DevboxWorkspaceGenerationManager({
      sourceRoot: source,
      generationsRoot: generations,
      sync,
      now: () => clock++,
      maxRetainedGenerations: 1
    })
    const first = await manager.createGeneration()
    const lease = await manager.acquireLease(first.id, 'job-lease')
    await manager.createGeneration()
    expect(await manager.verifyGeneration(first.id)).toBe(true)
    expect(await manager.listGenerations()).toHaveLength(2)
    await lease.release()
    await manager.prune()
    expect(await manager.listGenerations()).toHaveLength(1)
  })

  it('uses isolated files rather than hardlinks', async () => {
    const { source, generations } = await fixture()
    const manager = new DevboxWorkspaceGenerationManager({
      sourceRoot: source,
      generationsRoot: generations,
      sync: new FakeSync()
    })
    const generation = await manager.createGeneration()
    const sourceStat = await stat(join(source, 'src', 'main.ts'))
    const generationStat = await stat(join(generation.root, 'src', 'main.ts'))
    expect(generationStat.ino).not.toBe(sourceStat.ino)
  })
})
