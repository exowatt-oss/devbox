import { redactedDevboxValue } from '../shared/devbox-errors'

export const REDACTED_TEXT = redactedDevboxValue().value
export const CIRCULAR_TEXT = '[Circular]'

// This is intentionally broader than the existing telemetry helper's key
// blocklist because Devbox records include argv, Error properties, Maps, Sets,
// and provider diagnostics rather than only telemetry attributes.
const SENSITIVE_KEY_PATTERN =
  /(?:^|[^a-z0-9])(?:api[-_. ]?key|access[-_. ]?key|secret|token|password|passwd|credential|authorization|bearer|cookie|private[-_. ]?key|refresh[-_. ]?token|client[-_. ]?secret)(?:$|[^a-z0-9])/i

const SENSITIVE_KEY_COMPACT_PATTERN =
  /^(?:apikey|accesskey|secret|token|password|passwd|credential|authorization|bearer|cookie|privatekey|refreshtoken|clientsecret)$/i

export const VALUE_SHAPE_PATTERN =
  /(?:-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----|\bBearer\s+[^\s,;)}\]]+|\b(?:api[-_. ]?key|access[-_. ]?key|token|secret|password|credential|authorization|private[-_. ]?key)\s*[:=]\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+))/gi

export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
export const URL_USERINFO_PATTERN = /(https?:\/\/)[^/@\s]+@/gi
export const DEVBOX_REDACTION_TAG_PATTERN = /\[redacted(?::[^\]]+)?\]/gi
export const LIKELY_DEVBOX_HELPER_INPUT =
  /(?:api[-_. ]?key|access[-_. ]?key|token|secret|password|credential|authorization|bearer|private[-_. ]?key)\s*[:=]|sk-ant-|sk-(?:proj-)?|gh[pousr]_|AKIA[0-9A-Z]{16}|xox[baprsoe]-|eyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z0-9 ]+-----|https?:\/\/[^/@\s]+@|\b[A-Z_][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*\s*=/i

export const ARGV_SECRET_FLAG_PATTERN =
  /^--?(?:api[-_. ]?key|access[-_. ]?key|token|secret|password|passwd|credential|authorization|bearer|private[-_. ]?key)(?:=|$)/i

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return SENSITIVE_KEY_COMPACT_PATTERN.test(normalized) || SENSITIVE_KEY_PATTERN.test(key)
}
