import { describe, expect, it } from 'vitest'
import {
  createDevboxError,
  getDevboxUserMessage,
  redactedDevboxValue,
  type DevboxErrorCode
} from './devbox-errors'

describe('Devbox errors and redaction boundary', () => {
  it('keeps stable codes mapped to user-safe messages', () => {
    const codes: DevboxErrorCode[] = ['journal_corrupt', 'bridge_denied']
    for (const code of codes) {
      const error = createDevboxError(code)
      expect(error.code).toBe(code)
      expect(error.message).toBe(getDevboxUserMessage(code))
    }
  })

  it('exposes only a marker at the redaction boundary', () => {
    const marker = redactedDevboxValue()
    expect(marker).toEqual({ kind: 'devbox-redacted', value: '[REDACTED]' })
    expect(createDevboxError('auth_required', { context: { redacted: marker } })).toEqual({
      code: 'auth_required',
      message: getDevboxUserMessage('auth_required'),
      retryable: false,
      context: { redacted: marker }
    })
  })
})
