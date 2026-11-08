import {
  REMOTE_MCP_OAUTH_COMMAND,
  REMOTE_MCP_OAUTH_LEASE_TTL_MS,
  REMOTE_MCP_OAUTH_PROTOCOL_VERSION,
  type RemoteMcpOAuthRequest
} from './remote-mcp-oauth-contract'
import type { DevboxAuthorityEpoch, DevboxSshIdentity } from './devbox-types'

export const DEVBOX_BRIDGE_CAPABILITY_SCHEMA_VERSION = 1 as const
export const DEVBOX_BRIDGE_MAX_TTL_MS = REMOTE_MCP_OAUTH_LEASE_TTL_MS
export const DEVBOX_REMOTE_BRIDGE_PROTOCOL = REMOTE_MCP_OAUTH_COMMAND

export type DevboxRemoteMcpOAuthOperation = RemoteMcpOAuthRequest['op']

export type DevboxManagedBridgeSession = {
  kind: 'managed-phi-session'
  profileId: string
  targetId: string
  sessionId: string
  relayEpoch: DevboxAuthorityEpoch
  sshIdentity: DevboxSshIdentity
}

export type DevboxDetachedJobSession = {
  kind: 'detached-job'
  profileId: string
  targetId: string
}

export type DevboxBridgeCapability = {
  schemaVersion: typeof DEVBOX_BRIDGE_CAPABILITY_SCHEMA_VERSION
  capabilityId: string
  protocol: typeof DEVBOX_REMOTE_BRIDGE_PROTOCOL
  protocolVersion: typeof REMOTE_MCP_OAUTH_PROTOCOL_VERSION
  scope: 'remote-mcp-oauth'
  profileId: string
  targetId: string
  sessionId: string
  relayEpoch: DevboxAuthorityEpoch
  operations: readonly DevboxRemoteMcpOAuthOperation[]
  issuedAt: number
  expiresAt: number
}

export type DevboxBridgeCapabilityIssueResult =
  | { ok: true; capability: DevboxBridgeCapability }
  | { ok: false; reason: 'detached-job' | 'invalid-session' }

export type DevboxBridgeCapabilityUseResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' | 'operation-denied' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

function isOperation(value: unknown): value is DevboxRemoteMcpOAuthOperation {
  return value === 'prepare' || value === 'open' || value === 'close'
}

/**
 * Issue only a session-scoped capability. Detached jobs intentionally have no
 * representable capability because their context is a separate union member.
 */
export function issueDevboxBridgeCapability(
  session: DevboxManagedBridgeSession | DevboxDetachedJobSession,
  options: {
    capabilityId: string
    now: number
    ttlMs?: number
    operations?: readonly DevboxRemoteMcpOAuthOperation[]
  }
): DevboxBridgeCapabilityIssueResult {
  if (session.kind === 'detached-job') {
    return { ok: false, reason: 'detached-job' }
  }
  const ttlMs = options.ttlMs ?? DEVBOX_BRIDGE_MAX_TTL_MS
  const operations = [...(options.operations ?? ['prepare', 'open', 'close'])]
  if (
    !isNonEmptyString(options.capabilityId) ||
    !isNonEmptyString(session.profileId) ||
    !isNonEmptyString(session.targetId) ||
    !isNonEmptyString(session.sessionId) ||
    !isNonEmptyString(session.relayEpoch) ||
    !Number.isFinite(options.now) ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > DEVBOX_BRIDGE_MAX_TTL_MS ||
    operations.length === 0 ||
    operations.some((operation) => !isOperation(operation))
  ) {
    return { ok: false, reason: 'invalid-session' }
  }
  return {
    ok: true,
    capability: {
      schemaVersion: DEVBOX_BRIDGE_CAPABILITY_SCHEMA_VERSION,
      capabilityId: options.capabilityId.trim(),
      protocol: DEVBOX_REMOTE_BRIDGE_PROTOCOL,
      protocolVersion: REMOTE_MCP_OAUTH_PROTOCOL_VERSION,
      scope: 'remote-mcp-oauth',
      profileId: session.profileId.trim(),
      targetId: session.targetId.trim(),
      sessionId: session.sessionId.trim(),
      relayEpoch: session.relayEpoch,
      operations: [...new Set(operations)],
      issuedAt: options.now,
      expiresAt: options.now + ttlMs
    }
  }
}

export function isDevboxBridgeCapability(input: unknown): input is DevboxBridgeCapability {
  if (!isRecord(input) || !Array.isArray(input.operations)) {
    return false
  }
  return (
    input.schemaVersion === DEVBOX_BRIDGE_CAPABILITY_SCHEMA_VERSION &&
    input.protocol === DEVBOX_REMOTE_BRIDGE_PROTOCOL &&
    input.protocolVersion === REMOTE_MCP_OAUTH_PROTOCOL_VERSION &&
    input.scope === 'remote-mcp-oauth' &&
    isNonEmptyString(input.capabilityId) &&
    isNonEmptyString(input.profileId) &&
    isNonEmptyString(input.targetId) &&
    isNonEmptyString(input.sessionId) &&
    isNonEmptyString(input.relayEpoch) &&
    input.operations.length > 0 &&
    input.operations.every(isOperation) &&
    typeof input.issuedAt === 'number' &&
    Number.isFinite(input.issuedAt) &&
    typeof input.expiresAt === 'number' &&
    Number.isFinite(input.expiresAt) &&
    input.expiresAt > input.issuedAt &&
    input.expiresAt - input.issuedAt <= DEVBOX_BRIDGE_MAX_TTL_MS
  )
}

export function canUseDevboxBridgeCapability(
  capability: unknown,
  operation: DevboxRemoteMcpOAuthOperation,
  now: number
): DevboxBridgeCapabilityUseResult {
  if (!isDevboxBridgeCapability(capability)) {
    return { ok: false, reason: 'invalid' }
  }
  if (!Number.isFinite(now) || now >= capability.expiresAt) {
    return { ok: false, reason: 'expired' }
  }
  return capability.operations.includes(operation)
    ? { ok: true }
    : { ok: false, reason: 'operation-denied' }
}
