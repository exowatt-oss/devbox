import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxWorkspaceGenerationLease } from './devbox-workspace-generation-manager'

const LEASE_DIR = '.devbox-generation-leases'

const invalid = (field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { field } })

export class DevboxGenerationLeaseStore {
  private readonly leases = new Map<string, Set<string>>()

  constructor(private readonly generationsRoot: string) {}

  async acquire(
    generationId: string,
    ownerId: string,
    verifyGeneration: (generationId: string) => Promise<boolean>
  ): Promise<DevboxWorkspaceGenerationLease> {
    if (!(await verifyGeneration(generationId))) {
      throw invalid('generation-not-found')
    }

    const root = join(this.generationsRoot, generationId)
    const leaseDir = join(root, LEASE_DIR)
    await mkdir(leaseDir, { recursive: true, mode: 0o700 })
    const token = `${ownerId}-${randomUUID()}`
    await writeFile(join(leaseDir, token), ownerId, { mode: 0o600 })

    const active = this.leases.get(generationId) ?? new Set<string>()
    active.add(token)
    this.leases.set(generationId, active)
    let released = false

    const release = async (): Promise<void> => {
      if (released) {
        return
      }
      released = true
      active.delete(token)
      await rm(join(leaseDir, token), { force: true })
      if (active.size === 0) {
        this.leases.delete(generationId)
      }
    }

    return { generationId, ownerId, release }
  }

  async hasLease(generationId: string): Promise<boolean> {
    if ((this.leases.get(generationId)?.size ?? 0) > 0) {
      return true
    }
    try {
      const leaseFiles = await readdir(join(this.generationsRoot, generationId, LEASE_DIR))
      return leaseFiles.length > 0
    } catch {
      return false
    }
  }
}
