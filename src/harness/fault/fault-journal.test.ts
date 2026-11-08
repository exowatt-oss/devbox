import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DevboxOperationJournal } from '../../core/devbox-operation-journal'
import { operation } from './fault-roots'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function journalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'devbox-fault-journal-'))
  roots.push(root)
  const journalPath = join(root, 'operations.jsonl')
  return {
    root,
    journalPath,
    journal: new DevboxOperationJournal({
      journalPath,
      checkpointPath: join(root, 'operations.checkpoint')
    })
  }
}

describe('Devbox fault harness: operation journal', () => {
  it.each([
    ['partial-json', '{"schemaVersion":1,"sequence":2'],
    ['partial-checksum', '{"schemaVersion":1,"sequence":2,"checksum":"']
  ])('rejects a torn %s tail instead of accepting it', (_label, tail) => {
    const fixture = journalFixture()
    fixture.journal.append(operation('op-1'), { recordId: 'record-1' })
    writeFileSync(fixture.journalPath, `${readFileSync(fixture.journalPath, 'utf8')}${tail}`)

    expect(fixture.journal.replay()).toMatchObject({
      status: 'truncated-tail',
      error: { code: 'journal_truncated' },
      operations: [operation('op-1')]
    })
    expect(fixture.journal.append(operation('op-2', 2), { recordId: 'record-2' })).toMatchObject({
      status: 'rejected',
      error: { code: 'journal_truncated' }
    })
  })

  it('rejects a checksum-valid JSON record whose bytes were changed', () => {
    const fixture = journalFixture()
    fixture.journal.append(operation('op-1'), { recordId: 'record-1' })
    const record = JSON.parse(readFileSync(fixture.journalPath, 'utf8')) as {
      operation: { operationId: string }
      checksum: string
    }
    record.operation.operationId = 'silently-changed'
    writeFileSync(fixture.journalPath, `${JSON.stringify(record)}\n`)

    expect(fixture.journal.replay()).toMatchObject({
      status: 'corrupt',
      error: { code: 'journal_corrupt' }
    })
  })

  it('does not apply a valid record after an invalid complete line', () => {
    const fixture = journalFixture()
    fixture.journal.append(operation('op-1'), { recordId: 'record-1' })
    writeFileSync(fixture.journalPath, `${readFileSync(fixture.journalPath, 'utf8')}not-json\n`)

    const replay = fixture.journal.replay()
    expect(replay.status).toBe('corrupt')
    expect(replay.operations).toEqual([operation('op-1')])
    expect(replay.recordsApplied).toBe(1)
  })
})
