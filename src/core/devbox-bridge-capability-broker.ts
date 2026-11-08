import { randomUUID } from 'node:crypto'
import {
  canUseDevboxBridgeCapability,
  issueDevboxBridgeCapability,
  type DevboxBridgeCapability,
  type DevboxBridgeCapabilityUseResult,
  type DevboxManagedBridgeSession,
  type DevboxRemoteMcpOAuthOperation
} from '../shared/devbox-bridge-capabilities'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import { REMOTE_MCP_OAUTH_COMMAND } from '../shared/remote-mcp-oauth-contract'
import {
  registerDevboxBridgeCapability,
  unregisterDevboxBridgeCapability
} from './devbox-bridge-dispatch'

export type DevboxBridgeRequest = {
  capability: unknown
  operation: string
  argv: readonly string[]
  now?: number
}

export type DevboxBridgeBrokerOptions = {
  now?: () => number
  id?: () => string
}

export class DevboxBridgeCapabilityBroker {
  private readonly now: () => number
  private readonly id: () => string
  private readonly active = new Map<string, DevboxBridgeCapability>()

  constructor(options: DevboxBridgeBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
  }

  issueForPhi(session: DevboxManagedBridgeSession, ttlMs?: number): DevboxBridgeCapability {
    const result = issueDevboxBridgeCapability(session, {
      capabilityId: this.id(),
      now: this.now(),
      ttlMs
    })
    if (!result.ok) {
      throw this.errorForIssue(result.reason)
    }
    this.active.set(result.capability.capabilityId, result.capability)
    registerDevboxBridgeCapability(this, result.capability)
    return result.capability
  }

  issueForDetachedJob(): never {
    throw createDevboxError('bridge_denied', { context: { field: 'detached-job' } })
  }

  authorize(request: DevboxBridgeRequest): DevboxBridgeCapabilityUseResult {
    if (request.argv.length !== 1 || request.argv[0] !== REMOTE_MCP_OAUTH_COMMAND) {
      return { ok: false, reason: 'operation-denied' }
    }
    if (!isOAuthOperation(request.operation)) {
      return { ok: false, reason: 'operation-denied' }
    }
    const capability = this.active.get(
      typeof request.capability === 'object' &&
        request.capability !== null &&
        'capabilityId' in request.capability &&
        typeof request.capability.capabilityId === 'string'
        ? request.capability.capabilityId
        : ''
    )
    if (!capability) {
      return { ok: false, reason: 'invalid' }
    }
    const result = canUseDevboxBridgeCapability(
      capability,
      request.operation,
      request.now ?? this.now()
    )
    if (!result.ok && result.reason === 'expired') {
      this.revoke(capability.capabilityId)
    }
    return result
  }

  assertAuthorized(request: DevboxBridgeRequest): void {
    const result = this.authorize(request)
    if (result.ok) {
      return
    }
    const code = result.reason === 'expired' ? 'bridge_expired' : 'bridge_scope_denied'
    throw createDevboxError(code, { context: { field: result.reason } })
  }

  revoke(capabilityId: string): void {
    this.active.delete(capabilityId)
    unregisterDevboxBridgeCapability(this, capabilityId)
  }

  activeCount(): number {
    return this.active.size
  }

  private errorForIssue(
    reason: 'detached-job' | 'invalid-session'
  ): DevboxError {
    return createDevboxError('bridge_denied', { context: { field: reason } })
  }
}

function isOAuthOperation(value: string): value is DevboxRemoteMcpOAuthOperation {
  return value === 'prepare' || value === 'open' || value === 'close'
}
