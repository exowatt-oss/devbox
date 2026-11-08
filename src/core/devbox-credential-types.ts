/**
 * Value-free credential contracts for the Devbox credential plane.
 *
 * These types intentionally contain capability and status references, not
 * tokens, key material, environment values, or provider credential payloads.
 * A credential value must cross the credential broker's explicit delivery
 * boundary; it must never be representable in a Devbox profile or diagnostic
 * record.
 */

export const DEVBOX_CREDENTIAL_CAPABILITY_CLASSES = [
  'forwarded-only',
  'machine-enrolled',
  'oauth-per-host',
  'unavailable'
] as const

export type DevboxCredentialCapabilityClass = (typeof DEVBOX_CREDENTIAL_CAPABILITY_CLASSES)[number]

export const DEVBOX_CREDENTIAL_STATUS_STATES = [
  'available',
  'required',
  'expired',
  'revoked',
  'blocked',
  'unknown'
] as const

export type DevboxCredentialStatusState = (typeof DEVBOX_CREDENTIAL_STATUS_STATES)[number]

export type DevboxCredentialStatusReference = string & {
  readonly __devboxCredentialStatusReference: unique symbol
}

export type DevboxCredentialCapabilityReference = string & {
  readonly __devboxCredentialCapabilityReference: unique symbol
}

export type DevboxCredentialHostReference = string & {
  readonly __devboxCredentialHostReference: unique symbol
}

export type DevboxCredentialReference =
  | DevboxCredentialStatusReference
  | DevboxCredentialCapabilityReference
  | DevboxCredentialHostReference

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function createReference<T extends DevboxCredentialReference>(value: string, label: string): T {
  if (!REFERENCE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a non-secret opaque reference identifier.`)
  }
  return value as T
}

/** Construct a value-free capability reference after validating its identifier shape. */
export function createDevboxCredentialCapabilityReference(
  value: string
): DevboxCredentialCapabilityReference {
  return createReference<DevboxCredentialCapabilityReference>(value, 'Capability reference')
}

/** Construct a value-free status reference after validating its identifier shape. */
export function createDevboxCredentialStatusReference(
  value: string
): DevboxCredentialStatusReference {
  return createReference<DevboxCredentialStatusReference>(value, 'Status reference')
}

/** Construct a value-free host reference after validating its identifier shape. */
export function createDevboxCredentialHostReference(value: string): DevboxCredentialHostReference {
  return createReference<DevboxCredentialHostReference>(value, 'Host reference')
}

export type DevboxCredentialUnavailableReason =
  | 'not-enrolled'
  | 'host-untrusted'
  | 'requires-local-interaction'
  | 'provider-unsupported'
  | 'revoked'
  | 'policy-blocked'
  | 'unknown'

type DevboxCredentialCapabilityBase = {
  readonly capabilityRef: DevboxCredentialCapabilityReference
  readonly statusRef: DevboxCredentialStatusReference
  readonly status: DevboxCredentialStatusState
}

/**
 * A closed, value-free capability union. Each variant identifies where the
 * broker obtains or observes a capability; none can carry the capability
 * itself.
 */
export type DevboxCredentialCapability =
  | (DevboxCredentialCapabilityBase & {
      readonly class: 'forwarded-only'
      /** Reference to the Devbox connection/agent-forwarding lease. */
      readonly connectionRef: DevboxCredentialHostReference
    })
  | (DevboxCredentialCapabilityBase & {
      readonly class: 'machine-enrolled'
      /** Reference to the explicit enrollment record on the trusted host. */
      readonly enrollmentRef: DevboxCredentialCapabilityReference
      /** Reference to the host trust decision that permits enrollment. */
      readonly hostRef: DevboxCredentialHostReference
    })
  | (DevboxCredentialCapabilityBase & {
      readonly class: 'oauth-per-host'
      /** Reference to the per-host provider authorization record. */
      readonly authorizationRef: DevboxCredentialCapabilityReference
      readonly hostRef: DevboxCredentialHostReference
    })
  | (DevboxCredentialCapabilityBase & {
      readonly class: 'unavailable'
      readonly status: 'blocked' | 'unknown' | 'required' | 'revoked' | 'expired'
      readonly reason: DevboxCredentialUnavailableReason
    })

const COMMON_CAPABILITY_KEYS = new Set(['capabilityRef', 'statusRef', 'status', 'class'])
const CLASS_KEYS: Readonly<Record<DevboxCredentialCapabilityClass, ReadonlySet<string>>> = {
  'forwarded-only': new Set([...COMMON_CAPABILITY_KEYS, 'connectionRef']),
  'machine-enrolled': new Set([...COMMON_CAPABILITY_KEYS, 'enrollmentRef', 'hostRef']),
  'oauth-per-host': new Set([...COMMON_CAPABILITY_KEYS, 'authorizationRef', 'hostRef']),
  unavailable: new Set([...COMMON_CAPABILITY_KEYS, 'reason'])
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isReference = (value: unknown): value is DevboxCredentialReference =>
  typeof value === 'string' && REFERENCE_PATTERN.test(value)

/** Runtime guard that also rejects unknown/secret-bearing fields. */
export function isDevboxCredentialCapability(value: unknown): value is DevboxCredentialCapability {
  if (!isRecord(value) || typeof value.class !== 'string') {
    return false
  }
  const classKeys = CLASS_KEYS[value.class as DevboxCredentialCapabilityClass]
  if (!classKeys || Object.keys(value).some((key) => !classKeys.has(key))) {
    return false
  }
  if (
    !isReference(value.capabilityRef) ||
    !isReference(value.statusRef) ||
    typeof value.status !== 'string' ||
    !DEVBOX_CREDENTIAL_STATUS_STATES.includes(value.status as DevboxCredentialStatusState)
  ) {
    return false
  }
  if (value.class === 'forwarded-only') {
    return isReference(value.connectionRef)
  }
  if (value.class === 'machine-enrolled') {
    return isReference(value.enrollmentRef) && isReference(value.hostRef)
  }
  if (value.class === 'oauth-per-host') {
    return isReference(value.authorizationRef) && isReference(value.hostRef)
  }
  return (
    (value.status === 'blocked' ||
      value.status === 'unknown' ||
      value.status === 'required' ||
      value.status === 'revoked' ||
      value.status === 'expired') &&
    typeof value.reason === 'string' &&
    [
      'not-enrolled',
      'host-untrusted',
      'requires-local-interaction',
      'provider-unsupported',
      'revoked',
      'policy-blocked',
      'unknown'
    ].includes(value.reason)
  )
}

/**
 * Canonical secret-bearing surfaces excluded from generic workspace sync.
 * Entries are path globs, not values. The matcher also recognizes these
 * suffixes beneath an absolute home/workspace path.
 */
export const DEVBOX_ALWAYS_EXCLUDED_SECRET_PATHS = [
  '~/.pi/agent/auth.json',
  '~/.pi/agent/secrets.env',
  '~/.mcp-auth/**/*_lock.json',
  '~/.mcp-auth/**',
  '~/.config/gh/**',
  '~/.ssh/**',
  '~/.ssh/id_*',
  '~/.ssh/*.pem',
  '~/.ssh/*.key',
  '~/.ssh/known_hosts',
  '~/.pi/agent/certs/**',
  '~/.aws/**',
  '~/.config/gcloud/**',
  '~/.azure/**',
  '~/.config/oci/**',
  '~/.config/aliyun/**',
  '~/.docker/config.json',
  '~/.git-credentials',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.crt',
  '**/*.cer',
  '**/*.der'
] as const

/** Descriptive alias for callers that need the inventory by its security meaning. */
export const DEVBOX_SECRET_BEARING_PATHS = DEVBOX_ALWAYS_EXCLUDED_SECRET_PATHS

export type DevboxAlwaysExcludedSecretPath = (typeof DEVBOX_ALWAYS_EXCLUDED_SECRET_PATHS)[number]

export type DevboxWorkspacePathClass = 'excluded-from-generic-sync' | 'warning' | 'not-secret-like'

export type DevboxWorkspacePathClassification = {
  readonly path: string
  readonly class: DevboxWorkspacePathClass
  readonly classification: DevboxWorkspacePathClass
  readonly matchedRule?: DevboxAlwaysExcludedSecretPath
  readonly warning?: 'secret-like-path'
  /** This classifier examines path names only; embedded secrets are not exhaustive. */
  readonly detectionScope: 'path-only'
  readonly canDetectEveryEmbeddedSecret: false
}

const SECRET_LIKE_PATH_PATTERN =
  /(?:^|[/. _-])(?:auth|authorization|token|secret|credential|credentials|password|passwd|oauth|private[-_.]?key|api[-_.]?key|access[-_.]?key|certificate|cert|pem|cloud[-_.]?credentials?)(?:$|[/. _-])/i

function normalizePath(path: string): string {
  return path
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$|\/$/g, '')
}

function globSource(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return source
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern)
  const sources = [normalizedPattern]
  if (normalizedPattern.startsWith('~/')) {
    sources.push(normalizedPattern.slice(1))
  }
  return sources.some((source) => {
    if (new RegExp(`^${globSource(source)}$`, 'i').test(path)) {
      return true
    }
    // A `~/...` rule also applies to the same relative suffix below any home
    // or enrolled workspace root, without claiming that the root is a secret.
    return source.startsWith('/') && new RegExp(`${globSource(source)}$`, 'i').test(path)
  })
}

function isSecretLikePath(path: string): boolean {
  const normalized = normalizePath(path)
  const basename = normalized.split('/').at(-1) ?? normalized
  return (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    SECRET_LIKE_PATH_PATTERN.test(normalized) ||
    /(?:^|[_.-])(?:id_rsa|id_ed25519|id_ecdsa|credentials?|secrets?)(?:$|[_.-])/i.test(basename)
  )
}

/**
 * Classify a path for the generic sync boundary. A warning is deliberately not
 * a safety guarantee: source files can contain embedded secrets under an
 * ordinary-looking name and are outside this path-only check.
 */
export function classifyDevboxWorkspacePath(path: string): DevboxWorkspacePathClassification {
  const normalized = normalizePath(path)
  const matchedRule = DEVBOX_ALWAYS_EXCLUDED_SECRET_PATHS.find((rule) =>
    matchesGlob(normalized, rule)
  )
  const className: DevboxWorkspacePathClass = matchedRule
    ? 'excluded-from-generic-sync'
    : isSecretLikePath(normalized)
      ? 'warning'
      : 'not-secret-like'
  return {
    path,
    class: className,
    classification: className,
    ...(matchedRule ? { matchedRule } : {}),
    ...(className === 'warning' ? { warning: 'secret-like-path' as const } : {}),
    detectionScope: 'path-only',
    canDetectEveryEmbeddedSecret: false
  }
}

export const DEVBOX_PATH_CLASSIFIER_LIMITATION =
  'Path names are classified only; embedded secrets in ordinary-looking files are not exhaustively detectable.' as const
