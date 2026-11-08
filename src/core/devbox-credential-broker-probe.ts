import type { DevboxCredentialCapabilityReference } from './devbox-credential-types'
import type {
  DevboxCredentialBrokerContext,
  DevboxCredentialProbeObservation
} from './devbox-credential-broker-types'

export async function probeCapability(
  context: DevboxCredentialBrokerContext,
  capabilityRef: DevboxCredentialCapabilityReference
): Promise<DevboxCredentialProbeObservation> {
  const capability = context.capabilitiesByRef.get(capabilityRef)
  if (!capability) {
    return {
      reachability: 'unknown',
      authorization: 'unknown',
      reason: 'capability-not-registered'
    }
  }
  if (capability.class === 'unavailable') {
    return { reachability: 'unknown', authorization: 'unknown', reason: capability.reason }
  }
  if (capability.class === 'forwarded-only') {
    const connected =
      context.forwardedConnections.get(capability.connectionRef) ??
      capability.status === 'available'
    return connected
      ? { reachability: 'reachable', authorization: 'authorized' }
      : {
          reachability: 'unreachable',
          authorization: 'unknown',
          reason: 'connection-disconnected'
        }
  }
  if (capability.class === 'machine-enrolled') {
    const state = context.machineEnrollments.get(capabilityRef)
    if (state?.revoked || capability.status === 'revoked') {
      return {
        reachability: 'reachable',
        authorization: 'revoked',
        reason: 'generated-machine-identity-revoked'
      }
    }
  }
  if (capability.status === 'expired') {
    return { reachability: 'reachable', authorization: 'expired', reason: 'oauth-expired' }
  }
  if (capability.status === 'required') {
    return {
      reachability: 'reachable',
      authorization: 'required',
      reason: 'authorization-required'
    }
  }
  if (context.options.probe) {
    try {
      return await context.options.probe({
        capabilityRef,
        class: capability.class,
        targetId: context.options.targetId
      })
    } catch {
      return { reachability: 'unknown', authorization: 'unknown', reason: 'probe-failed' }
    }
  }
  return { reachability: 'reachable', authorization: 'authorized' }
}
