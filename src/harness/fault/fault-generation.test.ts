import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DevboxWorkspaceGenerationManager,
  type DevboxWorkspaceGenerationStage
} from '../../sync/devbox-workspace-generation-manager'
import { FaultingGenerationSync } from './fault-generation-sync'
import {
  createFaultRoot,
  InjectedFault,
  removeFaultRoot,
  type FaultRootFixture
} from './fault-roots'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeFaultRoot))
})

async function fixture(): Promise<FaultRootFixture> {
  const value = await createFaultRoot('devbox-fault-generation-')
  roots.push(value.root)
  return value
}

function managerFor(
  fixtureValue: FaultRootFixture,
  sync: FaultingGenerationSync,
  beforeStage?: (stage: DevboxWorkspaceGenerationStage) => void
): DevboxWorkspaceGenerationManager {
  return new DevboxWorkspaceGenerationManager({
    sourceRoot: fixtureValue.sourceRoot,
    generationsRoot: fixtureValue.generationsRoot,
    sync,
    now: () => 100,
    beforeStage
  })
}

describe('Devbox fault harness: consistent generations', () => {
  it.each<DevboxWorkspaceGenerationStage>([
    'flushing',
    'pausing',
    'copying',
    'verifying-generation',
    'resuming'
  ])('recovers a crash injected at %s without exposing a corrupt generation', async (stage) => {
    const fixtureValue = await fixture()
    const sync = new FaultingGenerationSync()
    let injected = false
    const manager = managerFor(fixtureValue, sync, (currentStage) => {
      if (!injected && currentStage === stage) {
        injected = true
        throw new InjectedFault(stage)
      }
    })

    await expect(manager.createGeneration()).rejects.toMatchObject({
      name: 'InjectedFault'
    })
    await manager.recover()
    const generations = await manager.listGenerations()
    expect(generations).toHaveLength(stage === 'resuming' ? 1 : 0)
    expect(
      (await readdir(fixtureValue.generationsRoot)).some((name) => name.startsWith('.staging-'))
    ).toBe(false)
    for (const generation of generations) {
      expect(await manager.verifyGeneration(generation.id)).toBe(true)
    }
    expect(manager.status()).toMatchObject({ stage: 'idle', liveSyncResumable: true })

    const recovered = await manager.createGeneration()
    expect(await manager.verifyGeneration(recovered.id)).toBe(true)
    expect(sync.calls).toContain('resume')
  })

  it('removes partial roots left by an app kill before the next generation attempt', async () => {
    const fixtureValue = await fixture()
    await mkdir(join(fixtureValue.generationsRoot, '.staging-killed'), {
      recursive: true,
      mode: 0o700
    })
    await writeFile(
      join(fixtureValue.generationsRoot, '.staging-killed', 'partial.bin'),
      'incomplete'
    )
    await mkdir(join(fixtureValue.generationsRoot, 'generation-killed'), {
      recursive: true,
      mode: 0o700
    })
    const manager = managerFor(fixtureValue, new FaultingGenerationSync())

    await manager.recover()

    expect(await manager.listGenerations()).toHaveLength(0)
    expect(await readdir(fixtureValue.generationsRoot)).toEqual([])
    const generation = await manager.createGeneration()
    expect(await manager.verifyGeneration(generation.id)).toBe(true)
  })

  it('does not claim live sync is resumable when every recovery resume fails', async () => {
    const fixtureValue = await fixture()
    const sync = new FaultingGenerationSync({ failEveryResume: true })
    let injected = false
    const manager = managerFor(fixtureValue, sync, (stage) => {
      if (!injected && stage === 'resuming') {
        injected = true
        throw new InjectedFault(stage)
      }
    })

    await expect(manager.createGeneration()).rejects.toBeInstanceOf(InjectedFault)
    expect(manager.status().liveSyncResumable).toBe(false)

    const restarted = managerFor(fixtureValue, sync)
    await restarted.recover()
    expect(restarted.status().liveSyncResumable).toBe(false)
  })
})
