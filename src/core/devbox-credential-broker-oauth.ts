import {
  canUseDevboxBridgeCapability,
  isDevboxBridgeCapability
} from '../shared/devbox-bridge-capabilities'
import type { DevboxCredentialStatusState } from './devbox-credential-types'
import { capabilityStatus } from './devbox-credential-broker-capabilities'
import type {
  DevboxCredentialBrokerContext,
  DevboxCredentialOAuthAuthorization,
  DevboxCredentialOAuthRequest,
  DevboxCredentialOAuthResult,
  OAuthState
} from './devbox-credential-broker-types'

export async function authorizeOAuth(
  context: DevboxCredentialBrokerContext,
  request: DevboxCredentialOAuthRequest
): Promise<DevboxCredentialOAuthResult> {
  const capability = context.capabilitiesByRef.get(request.capabilityRef)
  if (!capability || capability.class !== 'oauth-per-host') {
    return context.failure(
      'required',
      'provider-authorization-failed',
      'Register an OAuth-per-host capability before authorization.'
    )
  }
  const blocked = context.deliveryBlock(request.host)
  if (blocked) {
    return context.blockedDelivery(capability, blocked)
  }
  const now = context.options.now?.() ?? Date.now()
  if (
    !isDevboxBridgeCapability(request.bridgeCapability) ||
    request.bridgeCapability.profileId !== context.options.profileId ||
    request.bridgeCapability.targetId !== context.options.targetId ||
    request.bridgeCapability.sessionId.length === 0 ||
    canUseDevboxBridgeCapability(request.bridgeCapability, 'prepare', now).ok === false
  ) {
    return context.failure(
      'blocked',
      'bridge-denied',
      'Open the local browser through the existing scoped MCP OAuth bridge for this Devbox session.'
    )
  }
  if (!context.options.oauthBridge) {
    return context.failure(
      'unavailable',
      'bridge-denied',
      'The local browser bridge is unavailable; reconnect the Devbox session and retry authorization.'
    )
  }
  let result: DevboxCredentialOAuthAuthorization
  try {
    result = await context.options.oauthBridge({
      capability: request.bridgeCapability,
      hostRef: request.hostRef
    })
  } catch {
    result = { status: 'unavailable', reason: 'local-browser-bridge-failed' }
  }
  const status: DevboxCredentialStatusState =
    result.status === 'authorized'
      ? 'available'
      : result.status === 'expired'
        ? 'expired'
        : result.status === 'required'
          ? 'required'
          : 'blocked'
  const next = capabilityStatus(capability, status)
  context.capabilitiesByRef.set(request.capabilityRef, next)
  context.oauthStates.set(request.capabilityRef, { capability: next as OAuthState['capability'] })
  context.audit({
    action: 'oauth-authorized',
    profileId: context.options.profileId,
    targetId: context.options.targetId,
    capabilityRef: request.capabilityRef,
    status,
    reason: result.reason
  })
  return result.status === 'authorized'
    ? { ok: true, capability: next }
    : context.failure(
        result.status === 'expired' ? 'required' : 'unavailable',
        result.status === 'expired' ? 'transport-failed' : 'bridge-denied',
        result.status === 'expired'
          ? 'Re-authorize this host in the local browser; rotating OAuth caches and lock files are never copied.'
          : 'Complete the local browser authorization for this host, then rerun doctor.'
      )
}
