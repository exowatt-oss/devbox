import { describe, expect, it } from 'vitest'
import { redactedDevboxValue } from '../shared/devbox-errors'
import {
  DEVBOX_REDACTOR_DEFAULT_LIMITS,
  DevboxRedactor,
  classifyDevboxBundleDisposition,
  classifyDevboxJobOutput,
  redactDevboxRecord,
  type DevboxRedactionBoundary
} from './devbox-redactor'

const CANARY = 'synthetic-devbox-canary-7f2a'
// Synthetic fixtures are assembled at runtime so the export contains no token-like literals.
const PEM_CANARY = `-----BEGIN ${'PRIVATE'} KEY-----\n${CANARY}\n-----END ${'PRIVATE'} KEY-----`
const JWT_CANARY = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ canary_secret: CANARY })).toString('base64url'),
  'synthetic-signature-canary'
].join('.')
const BEARER_CANARY = `Bearer ${CANARY}`

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? String(entry) : entry))
}

describe('DevboxRedactor', () => {
  it('redacts synthetic canaries through nested objects, arrays, Maps, and Sets', () => {
    const map = new Map<unknown, unknown>([
      ['safe-label', `Bearer ${CANARY}`],
      ['token', CANARY]
    ])
    const input = {
      keep: { message: 'ordinary diagnostic context', count: 3 },
      nested: { authorization: BEARER_CANARY },
      array: ['before', { pem: PEM_CANARY }, { token: CANARY }],
      map,
      set: new Set([JWT_CANARY, 'plain-set-value'])
    }

    const output = new DevboxRedactor().redact(input) as Record<string, unknown>
    const outputText = serialized(output)
    expect(outputText).not.toContain(CANARY)
    expect(outputText).not.toContain(PEM_CANARY)
    expect(outputText).not.toContain(JWT_CANARY)
    expect(outputText).toContain(redactedDevboxValue().value)
    expect((output.keep as Record<string, unknown>).message).toBe('ordinary diagnostic context')
    expect((output.keep as Record<string, unknown>).count).toBe(3)
    expect((output.set as Set<unknown>).has('plain-set-value')).toBe(true)
    expect((output.map as Map<unknown, unknown>).get('safe-label')).toEqual(redactedDevboxValue())
    expect((output.map as Map<unknown, unknown>).has(redactedDevboxValue())).toBe(true)
  })

  it('redacts Error message and stack without mutating the Error', () => {
    const input = new Error(`request failed with ${BEARER_CANARY}`)
    input.stack = `Error: request failed with ${BEARER_CANARY}\n    at synthetic-fixture (fixture.ts:1:1)`
    const originalMessage = input.message
    const originalStack = input.stack

    const output = new DevboxRedactor().redact(input)
    expect(output).toBeInstanceOf(Error)
    expect((output as Error).message).not.toContain(CANARY)
    expect((output as Error).stack).not.toContain(CANARY)
    expect((output as Error).stack).toContain('fixture.ts:1:1')
    expect(input.message).toBe(originalMessage)
    expect(input.stack).toBe(originalStack)
  })

  it('handles cyclic objects and still redacts the canary below the cycle', () => {
    const input: Record<string, unknown> = {
      safe: 'preserve-me',
      credentials: { token: CANARY }
    }
    input.self = input
    const output = new DevboxRedactor().redact(input) as Record<string, unknown>

    expect(output.self).toBe('[Circular]')
    expect(serialized(output)).not.toContain(CANARY)
    expect(output.safe).toBe('preserve-me')
    expect((output.credentials as Record<string, unknown>).token).toEqual(redactedDevboxValue())
    expect(input.self).toBe(input)
  })

  it('redacts argv-like values using the preceding secret flag', () => {
    const input = ['node', 'tool.js', '--token', CANARY, '--mode', 'safe', `--api-key=${CANARY}`]
    const output = new DevboxRedactor().redact(input) as unknown[]

    expect(output[0]).toBe('node')
    expect(output[1]).toBe('tool.js')
    expect(output[2]).toBe('--token')
    expect(output[3]).toEqual(redactedDevboxValue())
    expect(output[4]).toBe('--mode')
    expect(output[5]).toBe('safe')
    expect(output[6]).toBe(`--api-key=${redactedDevboxValue().value}`)
    expect(serialized(output)).not.toContain(CANARY)
  })

  it('redacts PEM, JWT, and Bearer value shapes even without sensitive key names', () => {
    const output = new DevboxRedactor().redact({
      pem: PEM_CANARY,
      jwt: JWT_CANARY,
      text: BEARER_CANARY
    })
    const outputText = serialized(output)

    expect(outputText).not.toContain(CANARY)
    expect(outputText).not.toContain(PEM_CANARY)
    expect(outputText).not.toContain(JWT_CANARY)
    expect(outputText).toContain(redactedDevboxValue().value)
  })

  it('redacts by key name and preserves non-secret data exactly', () => {
    const input = {
      token: 'arbitrary value that has no recognizable token shape',
      name: 'Devbox fixture',
      count: 42,
      nested: { path: '/tmp/synthetic-project', enabled: true },
      list: ['one', 'two'],
      date: new Date('2026-08-28T00:00:00.000Z')
    }
    const output = new DevboxRedactor().redact(input) as Record<string, unknown>

    expect(output.token).toEqual(redactedDevboxValue())
    expect(output.name).toBe(input.name)
    expect(output.count).toBe(input.count)
    expect(output.nested).toEqual(input.nested)
    expect(output.list).toEqual(input.list)
    expect(output.date).toEqual(input.date)
  })

  it('does not mutate the input tree', () => {
    const input: Record<string, unknown> = {
      token: CANARY,
      nested: { authorization: BEARER_CANARY },
      map: new Map([['secret', CANARY]]),
      set: new Set([PEM_CANARY])
    }
    const originalMap = input.map as Map<string, string>
    const originalSet = input.set as Set<string>
    const before = {
      token: input.token,
      nested: { ...(input.nested as Record<string, unknown>) },
      map: [...originalMap.entries()],
      set: [...originalSet.values()]
    }

    new DevboxRedactor().redact(input)

    expect(input.token).toBe(before.token)
    expect(input.nested).toEqual(before.nested)
    expect([...originalMap.entries()]).toEqual(before.map)
    expect([...originalSet.values()]).toEqual(before.set)
  })

  it('enforces depth, node, and string-size caps', () => {
    const deep = { a: { b: { c: { d: CANARY } } } }
    const depthOutput = new DevboxRedactor({ maxDepth: 2 }).redact(deep)
    expect((depthOutput as Record<string, unknown>).a).toEqual({
      b: { c: redactedDevboxValue() }
    })

    const huge = Array.from({ length: 100_000 }, (_, index) => `safe-${index}`)
    const sizeOutput = new DevboxRedactor({ maxNodes: 16 }).redact(huge) as unknown[]
    expect(sizeOutput.length).toBeLessThan(100_000)
    expect(sizeOutput.at(-1)).toEqual(redactedDevboxValue())

    const stringOutput = new DevboxRedactor({ maxStringLength: 8 }).redact(`safe-${CANARY}`)
    expect(stringOutput).toEqual(redactedDevboxValue())
    expect(DEVBOX_REDACTOR_DEFAULT_LIMITS.maxNodes).toBeGreaterThan(huge.length / 100)
  })

  it('classifies sensitive job output as excluded, not merely redacted', () => {
    expect(classifyDevboxJobOutput()).toEqual({
      kind: 'job-output',
      bundleDisposition: 'excluded-from-default-bundle',
      reason: 'sensitive-workload'
    })
    expect(classifyDevboxBundleDisposition('job-output')).toBe('excluded-from-default-bundle')
    expect(classifyDevboxBundleDisposition('support-bundle')).toBe('included-in-default-bundle')

    const record = redactDevboxRecord({ stdout: `Bearer ${CANARY}` }, 'job-output')
    expect(record.bundleDisposition).toBe('excluded-from-default-bundle')
    expect(serialized(record.value)).not.toContain(CANARY)
  })

  it('returns the shared DevboxRedactionBoundary for whole-value redactions', () => {
    const output = new DevboxRedactor().redact(BEARER_CANARY) as DevboxRedactionBoundary
    expect(output).toEqual(redactedDevboxValue())
    expect(output.kind).toBe('devbox-redacted')
    expect(output.value).toBe('[REDACTED]')
  })
})
