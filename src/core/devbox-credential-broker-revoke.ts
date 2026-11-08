import {
  createDevboxCredentialStatusReference,
  type DevboxCredentialCapability
} from './devbox-credential-types'
import { capabilityStatus } from './devbox-credential-broker-capabilities'
import type {
  DevboxCredentialBrokerContext,
  DevboxCredentialHostBinding,
  DevboxCredentialRevokeResult
} from './devbox-credential-broker-types'

export async function revokeMachineCredential(
  context: DevboxCredentialBrokerContext,
  capabilityRef: string,
  host?: DevboxCredentialHostBinding
): Promise<DevboxCredentialRevokeResult> {
  const state = context.machineEnrollments.get(capabilityRef)
  const capability = context.capabilitiesByRef.get(capabilityRef)
  if (!state || !capability || capability.class !== 'machine-enrolled') {
    const unavailable = context.failure(
      'unavailable',
      'revoked',
      'No enrolled machine identity exists for this capability.'
    )
    return {
      ok: false,
      capability:
        capability ??
        ({
          class: 'unavailable',
          capabilityRef,
          statusRef: createDevboxCredentialStatusReference(`${capabilityRef}-status`),
          status: 'revoked',
          reason: 'revoked'
        } as DevboxCredentialCapability),
      remoteRemoval: 'not-required',
      providerRevocations: [],
      revokeInstructions: [unavailable.nextStep]
    }
  }
  state.revoked = true
  const revoked = capabilityStatus(state.capability, 'revoked') as DevboxCredentialCapability & {
    class: 'machine-enrolled'
  }
  state.capability = revoked
  context.capabilitiesByRef.set(capabilityRef, revoked)
  let remoteRemoval: DevboxCredentialRevokeResult['remoteRemoval'] = 'unavailable'
  if (host && !context.deliveryBlock(host)) {
    try {
      const identityRemoved = await context.options.transport.removeGeneratedIdentity({
        kind: 'remove-generated-identity',
        targetPath: state.identityPath,
        identityRef: state.identityRef,
        argv: [],
        env: {}
      })
      const credentialRemoved = await context.options.transport.removeGeneratedIdentity({
        kind: 'remove-generated-identity',
        targetPath: state.targetPath,
        identityRef: state.identityRef,
        argv: [],
        env: {}
      })
      remoteRemoval = identityRemoved.ok && credentialRemoved.ok ? 'completed' : 'unavailable'
    } catch {
      remoteRemoval = 'unavailable'
    }
  }
  const providerRevocations: {
    provider: string
    host: string
    status: 'completed' | 'unavailable' | 'not-required'
  }[] = []
  for (const providerHost of state.providerHosts) {
    let result: { ok: boolean } = { ok: false }
    if (context.options.providerRevoker) {
      try {
        result = await context.options.providerRevoker({
          provider: providerHost.provider,
          host: providerHost.host,
          identityRef: state.identityRef
        })
      } catch {
        result = { ok: false }
      }
    }
    providerRevocations.push({
      provider: providerHost.provider,
      host: providerHost.host,
      status: result.ok ? 'completed' : 'unavailable'
    })
  }
  context.audit({
    action: 'auth-revoked',
    profileId: context.options.profileId,
    targetId: context.options.targetId,
    capabilityRef,
    status: 'revoked',
    identityRef: state.identityRef
  })
  return {
    ok: true,
    capability: revoked,
    remoteRemoval,
    providerRevocations,
    revokeInstructions: state.revokeInstructions
  }
}
