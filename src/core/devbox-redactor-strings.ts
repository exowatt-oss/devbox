import { redactString as redactDevboxString } from '../shared/redactor-base'
import { redactedDevboxValue, type DevboxRedactionBoundary } from '../shared/devbox-errors'
import {
  ARGV_SECRET_FLAG_PATTERN,
  DEVBOX_REDACTION_TAG_PATTERN,
  LIKELY_DEVBOX_HELPER_INPUT,
  REDACTED_TEXT,
  URL_USERINFO_PATTERN,
  VALUE_SHAPE_PATTERN,
  JWT_PATTERN
} from './devbox-redactor-patterns'

function normalizeExistingRedaction(text: string): string {
  return text.replace(DEVBOX_REDACTION_TAG_PATTERN, REDACTED_TEXT)
}

/**
 * Redact a string while preserving surrounding diagnostic context. The
 * established observability helper remains the first line for its provider,
 * URL-userinfo, PEM, JWT, and env-shaped rules; Devbox adds Bearer and generic
 * credential-shaped values and normalizes all helper tags to one boundary.
 */
export function redactStringValue(
  value: string,
  maxStringLength: number
): string | DevboxRedactionBoundary {
  if (value.length > maxStringLength) {
    return redactedDevboxValue()
  }

  let output = value
  let changed = false

  if (LIKELY_DEVBOX_HELPER_INPUT.test(value)) {
    const helperOutput = redactDevboxString(value)
    if (helperOutput !== value) {
      output = normalizeExistingRedaction(helperOutput)
      changed = true
    }
  }

  const valueShapeOutput = output.replace(VALUE_SHAPE_PATTERN, () => {
    changed = true
    return REDACTED_TEXT
  })
  output = valueShapeOutput.replace(JWT_PATTERN, () => {
    changed = true
    return REDACTED_TEXT
  })
  output = output.replace(URL_USERINFO_PATTERN, '$1[REDACTED]@')
  if (output !== valueShapeOutput) {
    changed = true
  }

  if (!changed) {
    return value
  }
  return output.trim() === REDACTED_TEXT ? redactedDevboxValue() : output
}

export function redactArgValue(
  value: string,
  expectsSecret: boolean,
  maxStringLength: number
): string | DevboxRedactionBoundary {
  if (expectsSecret && value.length <= maxStringLength) {
    return redactedDevboxValue()
  }
  if (ARGV_SECRET_FLAG_PATTERN.test(value)) {
    const equalsIndex = value.indexOf('=')
    if (equalsIndex >= 0) {
      return `${value.slice(0, equalsIndex + 1)}${REDACTED_TEXT}`
    }
  }
  return redactStringValue(value, maxStringLength)
}
