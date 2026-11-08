export const REMOTE_MCP_OAUTH_PROTOCOL_VERSION = 1 as const
export const REMOTE_MCP_OAUTH_COMMAND = '__devbox_mcp_oauth' as const
export const REMOTE_MCP_OAUTH_CALLBACK_PATH = '/oauth/callback' as const
export const REMOTE_MCP_OAUTH_MAX_REQUEST_BYTES = 256 * 1024
export const REMOTE_MCP_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024
export const REMOTE_MCP_OAUTH_MAX_URL_LENGTH = 8 * 1024
export const REMOTE_MCP_OAUTH_MAX_SERVER_NAME_LENGTH = 256
export const REMOTE_MCP_OAUTH_MAX_REQUEST_ID_LENGTH = 128
export const REMOTE_MCP_OAUTH_MAX_LEASE_ID_LENGTH = 128
export const REMOTE_MCP_OAUTH_MAX_STATE_LENGTH = 2048
export const REMOTE_MCP_OAUTH_MIN_PORT = 1024
export const REMOTE_MCP_OAUTH_MAX_PORT = 65535
export const REMOTE_MCP_OAUTH_LEASE_TTL_MS = 30 * 60_000
export const REMOTE_MCP_OAUTH_EXPIRY_GRACE_MS = 5_000

/**
 * Stable wire vectors copied into phi's adapter tests. Keep field order and
 * values unchanged: these are the cross-repository protocol tripwires.
 */
export const REMOTE_MCP_OAUTH_PROTOCOL_V1_FIXTURES = {
  prepare: {
    schema: 1,
    op: 'prepare',
    requestId: '11111111-1111-4111-8111-111111111111',
    serverName: 'fixture-mcp',
    remotePort: 43123,
    path: '/oauth/callback',
    preferredRedirectUri: 'http://localhost:49152/oauth/callback'
  },
  open: {
    schema: 1,
    op: 'open',
    leaseId: 'lease-fixture-1',
    authorizationUrl:
      'https://issuer.example.test/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fcallback&state=fixture-state&code_challenge=fixture-challenge&code_challenge_method=S256',
    redirectUri: 'http://127.0.0.1:49152/oauth/callback'
  },
  close: {
    schema: 1,
    op: 'close',
    requestId: '11111111-1111-4111-8111-111111111111',
    leaseId: 'lease-fixture-1',
    outcome: 'complete'
  },
  ready: {
    schema: 1,
    status: 'ready',
    requestId: '11111111-1111-4111-8111-111111111111',
    leaseId: 'lease-fixture-1',
    redirectUri: 'http://127.0.0.1:49152/oauth/callback',
    expiresInMs: 1_800_000
  },
  opened: { schema: 1, status: 'opened' },
  closed: { schema: 1, status: 'closed' }
} as const

/** The exact protocol-v1 error code set shared with phi's command adapter. */
export const REMOTE_MCP_OAUTH_ERROR_CODES = [
  'unsupported_protocol',
  'invalid_request',
  'user_denied',
  'local_port_unavailable',
  'connection_lost',
  'expired',
  'browser_open_failed',
  'bridge_error'
] as const

export type RemoteMcpOAuthErrorCode = (typeof REMOTE_MCP_OAUTH_ERROR_CODES)[number]

export type RemoteMcpOAuthOutcome = 'complete' | 'cancelled' | 'failed'

export type RemoteMcpOAuthRequest =
  | {
      schema: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
      op: 'prepare'
      requestId: string
      serverName: string
      remotePort: number
      path: typeof REMOTE_MCP_OAUTH_CALLBACK_PATH
      preferredRedirectUri?: string
    }
  | {
      schema: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
      op: 'open'
      leaseId: string
      authorizationUrl: string
      redirectUri: string
    }
  | {
      schema: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
      op: 'close'
      requestId: string
      leaseId?: string
      outcome: RemoteMcpOAuthOutcome
    }

export type RemoteMcpOAuthResponse =
  | {
      schema: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
      status: 'ready'
      requestId: string
      leaseId: string
      redirectUri: string
      expiresInMs: typeof REMOTE_MCP_OAUTH_LEASE_TTL_MS
    }
  | {
      schema: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
      status: 'opened' | 'closed'
    }
  | {
      schema: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
      status: 'error'
      code: RemoteMcpOAuthErrorCode
      message: string
    }

export function isRemoteMcpOAuthCommand(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === REMOTE_MCP_OAUTH_COMMAND
}

export function isRemoteMcpOAuthOutcome(value: unknown): value is RemoteMcpOAuthOutcome {
  return value === 'complete' || value === 'cancelled' || value === 'failed'
}

export function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  )
}

/** Client request IDs are UUIDs so a retry cannot accidentally collide with another flow. */
export function isRemoteMcpOAuthRequestId(value: unknown): value is string {
  return (
    isBoundedString(value, REMOTE_MCP_OAUTH_MAX_REQUEST_ID_LENGTH) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

export function isRemoteMcpOAuthLeaseId(value: unknown): value is string {
  return isBoundedString(value, REMOTE_MCP_OAUTH_MAX_LEASE_ID_LENGTH)
}

export function isLoopbackPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= REMOTE_MCP_OAUTH_MIN_PORT &&
    value <= REMOTE_MCP_OAUTH_MAX_PORT
  )
}

/**
 * Return the consent-safe HTTPS endpoint identity for an authorization URL.
 * Query parameters are intentionally excluded because they carry OAuth state,
 * PKCE challenges, and provider-specific secrets.
 */
export function normalizeRemoteMcpOAuthAuthorizationEndpoint(value: unknown): string | null {
  if (!isBoundedString(value, REMOTE_MCP_OAUTH_MAX_URL_LENGTH)) {
    return null
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      url.origin === 'null'
    ) {
      return null
    }
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

export function makeRemoteMcpOAuthError(
  code: RemoteMcpOAuthErrorCode,
  message: string
): RemoteMcpOAuthResponse {
  return { schema: REMOTE_MCP_OAUTH_PROTOCOL_VERSION, status: 'error', code, message }
}
