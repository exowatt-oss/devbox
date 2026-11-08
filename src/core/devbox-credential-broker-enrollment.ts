import type { DevboxCredentialCapability } from './devbox-credential-types'
import {
  DEVBOX_CREDENTIAL_FILE_MODE,
  type DevboxCredentialAtomicWriteRequest,
  type DevboxCredentialAtomicWriteResult,
  type DevboxCredentialBrokerContext,
  type DevboxCredentialEnrollmentRequest,
  type DevboxCredentialEnrollmentResult,
  type DevboxCredentialProviderAuthorizationResult,
  type DevboxCredentialProviderAuthorizationSummary
} from './devbox-credential-broker-types'
import {
  assertDevboxCredentialDeliveryPath,
  capabilityStatus
} from './devbox-credential-broker-capabilities'
import {
  defaultRevokeInstructions,
  generateDevboxCredentialIdentity,
  isPrimarySshPrivateKeyPath,
  isText,
  PRIVATE_KEY_MATERIAL_PATTERN
} from './devbox-credential-broker-security'

export async function enrollMachineCredential(
  context: DevboxCredentialBrokerContext,
  request: DevboxCredentialEnrollmentRequest
): Promise<DevboxCredentialEnrollmentResult> {
  const capability = context.capabilitiesByRef.get(request.capabilityRef)
  if (!capability || capability.class !== 'machine-enrolled') {
    return context.failure(
      'required',
      'provider-authorization-failed',
      'Register a machine-enrolled capability before enrollment.'
    )
  }
  const blocked = context.deliveryBlock(request.host)
  if (blocked) {
    return context.blockedDelivery(capability, blocked)
  }
  if (!request.explicitEnrollment) {
    return context.failure(
      'required',
      'enrollment-not-explicit',
      'Confirm explicit enrollment on this verified Devbox host.'
    )
  }
  if (!isText(request.secret)) {
    return context.failure(
      'required',
      'transport-failed',
      'Provide the selected credential through the enrollment prompt; do not place it in profile or argv.'
    )
  }
  if (PRIVATE_KEY_MATERIAL_PATTERN.test(request.secret)) {
    return context.failure(
      'unavailable',
      'primary-key-forbidden',
      'The primary laptop SSH private key is never transferred; use the generated Devbox identity or agent forwarding.'
    )
  }
  assertDevboxCredentialDeliveryPath(request.targetPath)
  const identityPath = request.identityPath ?? `${request.targetPath}.devbox-identity`
  assertDevboxCredentialDeliveryPath(identityPath)
  if (
    (request.sourcePath && isPrimarySshPrivateKeyPath(request.sourcePath)) ||
    isPrimarySshPrivateKeyPath(request.targetPath) ||
    isPrimarySshPrivateKeyPath(identityPath)
  ) {
    return context.failure(
      'unavailable',
      'primary-key-forbidden',
      'Use a generated Devbox identity or agent forwarding; the primary laptop SSH private key is never transferred.'
    )
  }
  const identity = (context.options.identityGenerator ?? generateDevboxCredentialIdentity)()
  const writeSecret = async (
    targetPath: string,
    stdin: string
  ): Promise<DevboxCredentialAtomicWriteResult> => {
    const writeRequest: DevboxCredentialAtomicWriteRequest = {
      kind: 'atomic-secret-write',
      targetPath,
      stdin,
      argv: [],
      env: {},
      mode: DEVBOX_CREDENTIAL_FILE_MODE,
      atomic: true
    }
    const argv = writeRequest.argv as readonly string[]
    const env = writeRequest.env as Readonly<Record<string, string>>
    if (
      argv.some((value) => value.includes(stdin)) ||
      Object.values(env).some((value) => value.includes(stdin))
    ) {
      return { ok: false, atomic: false, mode: 0, targetPath }
    }
    try {
      return await context.options.transport.writeSecretAtomically(writeRequest)
    } catch {
      return { ok: false, atomic: false, mode: 0, targetPath }
    }
  }
  const identityWrite = await writeSecret(identityPath, identity.privateKey)
  const credentialWrite = await writeSecret(request.targetPath, request.secret)
  if (
    !identityWrite.ok ||
    !identityWrite.atomic ||
    identityWrite.mode !== DEVBOX_CREDENTIAL_FILE_MODE ||
    identityWrite.targetPath !== identityPath ||
    !credentialWrite.ok ||
    !credentialWrite.atomic ||
    credentialWrite.mode !== DEVBOX_CREDENTIAL_FILE_MODE ||
    credentialWrite.targetPath !== request.targetPath
  ) {
    return context.failure(
      'unavailable',
      'transport-failed',
      'The verified host did not confirm atomic mode-0600 credential writes.'
    )
  }
  const providerHosts = request.providerHosts ?? []
  const authorizations: DevboxCredentialProviderAuthorizationSummary[] = []
  for (const providerHost of providerHosts) {
    const revokeInstructions =
      providerHost.revokeInstructions ??
      defaultRevokeInstructions(providerHost.provider, providerHost.host)
    let authorization: DevboxCredentialProviderAuthorizationResult
    try {
      authorization = context.options.providerAuthorizer
        ? await context.options.providerAuthorizer({
            provider: providerHost.provider,
            host: providerHost.host,
            identityRef: identity.identityRef,
            publicKey: identity.publicKey
          })
        : { status: 'unavailable' }
    } catch {
      authorization = { status: 'unavailable' }
    }
    const summary = {
      provider: providerHost.provider,
      host: providerHost.host,
      status: authorization.status,
      revokeInstructions: authorization.revokeInstructions ?? revokeInstructions
    } as DevboxCredentialProviderAuthorizationSummary
    authorizations.push(summary)
    context.audit({
      action: 'provider-authorized',
      profileId: context.options.profileId,
      targetId: context.options.targetId,
      capabilityRef: request.capabilityRef,
      status:
        authorization.status === 'authorized'
          ? 'available'
          : authorization.status === 'required'
            ? 'required'
            : 'blocked',
      provider: providerHost.provider,
      host: providerHost.host,
      identityRef: identity.identityRef
    })
  }
  const allAuthorized = authorizations.every(
    (authorization) => authorization.status === 'authorized'
  )
  if (!allAuthorized) {
    const next = capabilityStatus(capability, 'required')
    context.capabilitiesByRef.set(request.capabilityRef, next)
    return context.failure(
      'required',
      'provider-authorization-failed',
      'Authorize the generated Devbox identity at every required Git/private host, then retry the probe.'
    )
  }
  const enrolled = capabilityStatus(capability, 'available') as DevboxCredentialCapability & {
    class: 'machine-enrolled'
  }
  context.capabilitiesByRef.set(request.capabilityRef, enrolled)
  const state = {
    capability: enrolled,
    identityRef: identity.identityRef,
    targetPath: request.targetPath,
    identityPath,
    providerHosts,
    revoked: false,
    revokeInstructions: [
      ...new Set(authorizations.map((authorization) => authorization.revokeInstructions))
    ]
  }
  context.machineEnrollments.set(request.capabilityRef, state)
  context.audit({
    action: 'secret-delivered',
    profileId: context.options.profileId,
    targetId: context.options.targetId,
    capabilityRef: request.capabilityRef,
    status: 'available',
    identityRef: identity.identityRef
  })
  return {
    ok: true,
    capability: enrolled,
    identityRef: identity.identityRef,
    providerAuthorizations: authorizations,
    revokeInstructions: state.revokeInstructions
  }
}
