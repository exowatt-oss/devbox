import { describe, expect, it } from 'vitest'
import { redactedDevboxValue } from '../../shared/devbox-errors'
import {
  DEVBOX_REDACTION_TARGETS,
  DevboxRedactor,
  type DevboxRedactionTarget
} from '../../core/devbox-redactor'
import { SECURITY_CANARIES, allSecurityCanaries } from './security-corpus'

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Map) {
      return { map: [...entry.entries()] }
    }
    if (entry instanceof Set) {
      return { set: [...entry.values()] }
    }
    return typeof entry === 'bigint' ? String(entry) : entry
  })
}

function errorPayload(): Record<string, unknown> {
  return {
    error: {
      name: 'ProviderError',
      message: `provider failed with ${SECURITY_CANARIES.oauthReason}`,
      stack: `ProviderError: ${SECURITY_CANARIES.oauthReason}\n at fixture.ts:1:1`,
      cause: {
        message: `nested token: ${SECURITY_CANARIES.nestedToken}`,
        token: SECURITY_CANARIES.nestedToken
      },
      details: {
        secret: SECURITY_CANARIES.machineSecret,
        privateKey: SECURITY_CANARIES.generatedPrivateKey
      }
    }
  }
}

describe('Devbox redaction security harness', () => {
  it('redacts every broker credential shape in nested serialized error payloads', () => {
    const payload = {
      secret: SECURITY_CANARIES.machineSecret,
      privateKey: SECURITY_CANARIES.generatedPrivateKey,
      authorization: SECURITY_CANARIES.oauthReason,
      forwardedDiagnostic: SECURITY_CANARIES.forwardedReason,
      argv: ['provider', '--token', SECURITY_CANARIES.nestedToken],
      nestedSerializedError: JSON.parse(JSON.stringify(errorPayload())),
      map: new Map([['token', SECURITY_CANARIES.nestedToken]]),
      set: new Set([SECURITY_CANARIES.oauthReason])
    }
    const redactor = new DevboxRedactor()
    const output = redactor.redact(payload)
    const text = serialize(output)

    for (const canary of allSecurityCanaries()) {
      expect(text).not.toContain(canary)
    }
    expect((output as Record<string, unknown>).secret).toEqual(redactedDevboxValue())
    expect((output as Record<string, unknown>).privateKey).toEqual(redactedDevboxValue())
    expect((output as Record<string, unknown>).nestedSerializedError).toBeDefined()
  })

  it('redacts all supported boundary targets without changing bundle policy', () => {
    const redactor = new DevboxRedactor()
    for (const target of DEVBOX_REDACTION_TARGETS) {
      const record = redactor.redactForTarget(
        { error: `authorization: ${SECURITY_CANARIES.oauthReason}` },
        target as DevboxRedactionTarget
      )
      expect(serialize(record.value)).not.toContain(SECURITY_CANARIES.oauthReason)
      expect(record.target).toBe(target)
      expect(record.bundleDisposition).toBe(
        target === 'job-output' ? 'excluded-from-default-bundle' : 'included-in-default-bundle'
      )
    }
  })

  it('keeps ordinary error context while replacing credential values', () => {
    const error = new Error(`request failed with ${SECURITY_CANARIES.oauthReason}`)
    error.stack = `${error.message}\n at security-fixture.ts:2:3`
    const output = new DevboxRedactor().redact(error)

    expect(output).toBeInstanceOf(Error)
    expect((output as Error).message).not.toContain(SECURITY_CANARIES.oauthReason)
    expect((output as Error).stack).toContain('security-fixture.ts:2:3')
    expect((output as Error).stack).not.toContain(SECURITY_CANARIES.oauthReason)
  })
})
