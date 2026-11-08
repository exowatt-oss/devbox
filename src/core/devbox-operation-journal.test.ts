import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DevboxOperationJournal } from './devbox-operation-journal'
import type { DevboxAuthorityEpoch, DevboxOperationEnvelope } from '../shared/devbox-types'

function operation(operationId: string, updatedAt: number): DevboxOperationEnvelope {
  return {
    operationId,
    kind: 'sync',
    phase: 'ready',
    idempotencyKey: `idem-${operationId}`,
    cancellation: { requested: false },
    timestamps: { startedAt: 1, updatedAt },
    authorityEpoch: {
      epoch: `epoch-${updatedAt}` as DevboxAuthorityEpoch,
      sequence: updatedAt,
      owner: 'remote',
      observedAt: updatedAt,
      committedAt: updatedAt
    },
    status: {
      execution: { side: 'remote', state: 'running' },
      authority: { side: 'remote', state: 'owner' },
      freshness: { state: 'fresh', observedAt: updatedAt },
      conflict: { state: 'none' },
      drift: { state: 'none' },
      connectivity: { state: 'online' },
      auth: { state: 'healthy' },
      disk: { state: 'healthy', freeBytes: 100 }
    }
  }
}

function makeJournal(
  options: Partial<Omit<ConstructorParameters<typeof DevboxOperationJournal>[0], 'journalPath' | 'checkpointPath'>> = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'devbox-journal-'))
  return {
    root,
    journal: new DevboxOperationJournal({
      journalPath: join(root, 'operations.jsonl'),
      checkpointPath: join(root, 'operations.checkpoint'),
      ...options
    })
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
  })
}

function buildAppender(root: string): string {
  const source = join(root, 'append-child.mjs')
  const output = join(root, 'append-child-bundle.mjs')
  const journalSource = fileURLToPath(new URL('./devbox-operation-journal.ts', import.meta.url))
  writeFileSync(
    source,
    `import { DevboxOperationJournal } from ${JSON.stringify(journalSource)}
const [journalPath, childIndex, count] = process.argv.slice(2)
const journal = new DevboxOperationJournal({ journalPath })
for (let index = 0; index < Number(count); index += 1) {
  const updatedAt = Number(childIndex) * Number(count) + index + 1
  const nextOperation = ${JSON.stringify(operation('shared-operation', 1))}
  nextOperation.timestamps.updatedAt = updatedAt
  const result = journal.append(nextOperation, {
    recordId: \`child-\${childIndex}-\${index}\`
  })
  if (result.status !== 'written') {
    console.error(result.error.code)
    process.exitCode = 1
    break
  }
}
`
  )
  buildSync({ entryPoints: [source], bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile: output })
  return output
}

describe('DevboxOperationJournal', () => {
  it('appends checksummed records and checkpoints atomically', () => {
    const { journal } = makeJournal()
    const written = journal.append(operation('op-1', 1), { recordId: 'record-1' })
    expect(written.status).toBe('written')
    expect(journal.checkpoint()).toMatchObject({ status: 'checkpointed' })
    const replay = journal.replay()
    expect(replay.status).toBe('ok')
    expect(replay.checkpointStatus).toBe('valid')
    expect(replay.operations.map((entry) => entry.operationId)).toEqual(['op-1'])
  })

  it('replays duplicate records deterministically', () => {
    const { root, journal } = makeJournal()
    journal.append(operation('op-1', 1), { recordId: 'record-1' })
    const path = join(root, 'operations.jsonl')
    const raw = readFileSync(path, 'utf8')
    writeFileSync(path, `${raw}${raw}`)
    const replay = journal.replay()
    expect(replay.status).toBe('ok')
    expect(replay.duplicateRecords).toBe(1)
    expect(replay.operations).toHaveLength(1)
    expect(replay.operations[0]?.operationId).toBe('op-1')
  })

  it('detects a complete record with an invalid checksum', () => {
    const { root, journal } = makeJournal()
    journal.append(operation('op-1', 1), { recordId: 'record-1' })
    const path = join(root, 'operations.jsonl')
    const record = JSON.parse(readFileSync(path, 'utf8')) as { checksum: string }
    record.checksum = '0'.repeat(64)
    writeFileSync(path, `${JSON.stringify(record)}\n`)
    expect(journal.replay()).toMatchObject({
      status: 'corrupt',
      error: { code: 'journal_corrupt' }
    })
  })

  it('detects a truncated tail and refuses to append over it', () => {
    const { root, journal } = makeJournal()
    journal.append(operation('op-1', 1), { recordId: 'record-1' })
    const path = join(root, 'operations.jsonl')
    writeFileSync(path, `${readFileSync(path, 'utf8')} {"schemaVersion":1`)
    const replay = journal.replay()
    expect(replay.status).toBe('truncated-tail')
    expect(replay.operations.map((entry) => entry.operationId)).toEqual(['op-1'])
    expect(journal.append(operation('op-2', 2), { recordId: 'record-2' })).toMatchObject({
      status: 'rejected',
      error: { code: 'journal_truncated' }
    })
  })

  it('serializes appends from separate processes with unique sequences', async () => {
    const { root, journal } = makeJournal()
    const journalPath = join(root, 'operations.jsonl')
    const childScript = buildAppender(root)
    const childCount = 4
    const recordsPerChild = 12
    await Promise.all(
      Array.from({ length: childCount }, (_, childIndex) =>
        waitForExit(spawn(process.execPath, [childScript, journalPath, String(childIndex), String(recordsPerChild)]))
      )
    )
    const records = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number; operation: { operationId: string } })
    const sequences = records.map(({ sequence }) => sequence)
    expect(journal.replay()).toMatchObject({
      status: 'ok',
      recordsRead: childCount * recordsPerChild,
      recordsApplied: childCount * recordsPerChild
    })
    expect(records).toHaveLength(childCount * recordsPerChild)
    expect(new Set(sequences)).toHaveProperty('size', childCount * recordsPerChild)
    expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true)
    expect(new Set(records.map(({ operation }) => operation.operationId))).toEqual(new Set(['shared-operation']))
  })

  it('reclaims a lock owned by a dead process', async () => {
    const { root, journal } = makeJournal()
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = dead.pid
    if (deadPid === undefined) {
      throw new Error('child process did not expose a pid')
    }
    await waitForExit(dead)
    const lockPath = `${join(root, 'operations.jsonl')}.lock`
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, createdAt: Date.now() }))
    expect(journal.append(operation('op-1', 1), { recordId: 'record-1' })).toMatchObject({ status: 'written' })
    expect(() => readFileSync(lockPath)).toThrow()
  })

  it('returns a retryable error when the lock does not become available', () => {
    const { root, journal } = makeJournal({
      lockOptions: { timeoutMs: 40, pollMs: 5 }
    })
    const lockPath = `${join(root, 'operations.jsonl')}.lock`
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    try {
      expect(journal.append(operation('op-1', 1), { recordId: 'record-1' })).toMatchObject({
        status: 'rejected',
        error: { code: 'journal_locked', retryable: true }
      })
    } finally {
      unlinkSync(lockPath)
    }
  })

})
