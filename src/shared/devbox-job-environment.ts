// Bare AUTH remains valid for SSH_AUTH_SOCK; only credential-bearing forms are denied.
export const DEVBOX_JOB_ENVIRONMENT_DENIED_KEY_PATTERNS = [
  /^DEVBOX_BRIDGE_CAPABILITY$/i,
  /(?:^|_)(?:BRIDGE|CAPABILITY)(?:_|$)/i,
  /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY|AUTHORIZATION|AUTH[_-]?(?:TOKEN|KEY|SECRET|CREDENTIALS?)|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/i
] as const

type DevboxJobEnvironmentValidation = { ok: true } | { ok: false; reason: 'invalid' | 'denied-key' }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

export function isDeniedDevboxJobEnvironmentKey(key: string): boolean {
  return DEVBOX_JOB_ENVIRONMENT_DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

export function validateDevboxJobEnvironment(input: unknown): DevboxJobEnvironmentValidation {
  if (input === undefined) {
    return { ok: true }
  }
  if (!isRecord(input)) {
    return { ok: false, reason: 'invalid' }
  }
  try {
    if (Object.getOwnPropertySymbols(input).length > 0) {
      return { ok: false, reason: 'invalid' }
    }
    for (const key of Object.getOwnPropertyNames(input)) {
      const value = input[key]
      if (
        key.length === 0 ||
        key.includes('=') ||
        key.includes('\u0000') ||
        typeof value !== 'string' ||
        value.includes('\u0000')
      ) {
        return { ok: false, reason: 'invalid' }
      }
      if (isDeniedDevboxJobEnvironmentKey(key)) {
        return { ok: false, reason: 'denied-key' }
      }
    }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true }
}
