export const DEVBOX_ERROR_CODES = [
  'profile_not_found',
  'profile_malformed',
  'profile_version_unsupported',
  'profile_id_invalid',
  'journal_corrupt',
  'journal_locked',
  'journal_truncated',
  'journal_checkpoint_invalid',
  'toolchain_invalid',
  'toolchain_digest_invalid',
  'toolchain_latest_forbidden',
  'bridge_denied',
  'bridge_expired',
  'bridge_scope_denied',
  'ssh_identity_mismatch',
  'operation_conflict',
  'offline',
  'auth_required',
  'disk_pressure',
  'cancelled',
  'unknown'
] as const

export type DevboxErrorCode = (typeof DEVBOX_ERROR_CODES)[number]

export const DEVBOX_RETRYABLE_ERROR_CODES: readonly DevboxErrorCode[] = ['journal_locked']

export const DEVBOX_ERROR_MESSAGES: Readonly<Record<DevboxErrorCode, string>> = {
  profile_not_found: 'The Devbox profile was not found.',
  profile_malformed: 'The Devbox profile is malformed and Devbox has been disabled.',
  profile_version_unsupported:
    'The Devbox profile was written by a newer build and Devbox has been disabled.',
  profile_id_invalid: 'The Devbox profile identifier is invalid.',
  journal_corrupt: 'The Devbox operation journal is corrupt and needs explicit recovery.',
  journal_locked: 'The Devbox operation journal is busy in another Devbox process; retry shortly.',
  journal_truncated: 'The Devbox operation journal has an incomplete tail and needs recovery.',
  journal_checkpoint_invalid: 'The Devbox journal checkpoint is invalid and was not used.',
  toolchain_invalid: 'The Devbox toolchain lock is invalid.',
  toolchain_digest_invalid: 'The Devbox toolchain digest is invalid.',
  toolchain_latest_forbidden: 'Devbox toolchain locks must pin an immutable version.',
  bridge_denied: 'The requested remote bridge capability is not available.',
  bridge_expired: 'The remote bridge capability has expired.',
  bridge_scope_denied: 'The remote bridge request is outside the MCP OAuth protocol.',
  ssh_identity_mismatch: 'The SSH endpoint or host key no longer matches the Devbox profile.',
  operation_conflict: 'Another Devbox operation owns this profile.',
  offline: 'The Devbox host is offline.',
  auth_required: 'Authorization is required for this Devbox capability.',
  disk_pressure: 'The Devbox host does not have enough free disk space.',
  cancelled: 'The Devbox operation was cancelled.',
  unknown: 'Devbox encountered an unexpected failure.'
}

/** Values crossing the diagnostic/logging boundary must use this marker. */
export type DevboxRedactionBoundary = {
  readonly kind: 'devbox-redacted'
  readonly value: '[REDACTED]'
  readonly __devboxRedactionBoundary: unique symbol
}

const REDACTED: DevboxRedactionBoundary = Object.freeze({
  kind: 'devbox-redacted',
  value: '[REDACTED]'
}) as DevboxRedactionBoundary

export function redactedDevboxValue(): DevboxRedactionBoundary {
  return REDACTED
}

export type DevboxSafeDetail = string | number | boolean | null | DevboxRedactionBoundary

/** Deliberately closed: arbitrary error objects and request payloads cannot be logged here. */
export type DevboxSafeErrorContext = Readonly<{
  operationId?: string
  profileId?: string
  phase?: string
  side?: 'local' | 'remote' | 'none'
  retryable?: boolean
  field?: string
  redacted?: DevboxRedactionBoundary
}>

export type DevboxError = {
  code: DevboxErrorCode
  message: string
  retryable: boolean
  context?: DevboxSafeErrorContext
}

export function getDevboxUserMessage(code: DevboxErrorCode): string {
  return DEVBOX_ERROR_MESSAGES[code]
}

export function createDevboxError(
  code: DevboxErrorCode,
  options: { message?: string; retryable?: boolean; context?: DevboxSafeErrorContext } = {}
): DevboxError {
  return {
    code,
    message: options.message ?? getDevboxUserMessage(code),
    retryable: options.retryable ?? DEVBOX_RETRYABLE_ERROR_CODES.includes(code),
    ...(options.context ? { context: options.context } : {})
  }
}
