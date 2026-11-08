import {
  capabilityForDeclaration,
  capabilityStatus,
  classifyDevboxCredentialDeclaration,
  assertDevboxCredentialDeliveryPath,
  isDevboxCredentialPathExcludedFromSync
} from './devbox-credential-broker-capabilities'
import { enrollMachineCredential } from './devbox-credential-broker-enrollment'
import { authorizeOAuth } from './devbox-credential-broker-oauth'
import { probeCapability } from './devbox-credential-broker-probe'
import { revokeMachineCredential } from './devbox-credential-broker-revoke'
import { isPrimarySshPrivateKeyPath, isText } from './devbox-credential-broker-security'
import type {
  DevboxCredentialBrokerContext,
  DevboxCredentialBrokerAuditEvent,
  DevboxCredentialBrokerOptions,
  DevboxCredentialDeliveryFailure,
  DevboxCredentialEnrollmentResult,
  DevboxCredentialForwardedConnection,
  DevboxCredentialHostBinding,
  DevboxCredentialOAuthResult,
  DevboxCredentialProviderHost,
  DevboxCredentialProbeObservation,
  DevboxCredentialRevokeResult,
  MachineEnrollmentState,
  OAuthState
} from './devbox-credential-broker-types'
import type {
  DevboxCredentialCapability,
  DevboxCredentialCapabilityReference,
  DevboxCredentialHostReference
} from './devbox-credential-types'
import { DevboxRedactor, type DevboxRedactionBoundary } from './devbox-redactor'
import type { DevboxCredentialCapabilityDeclaration } from '../shared/devbox-types'

export {
  DEVBOX_CREDENTIAL_FILE_MODE,
  DEVBOX_OAUTH_CACHE_EXCLUSION_GLOB,
  DEVBOX_OAUTH_LOCK_SUFFIX
} from './devbox-credential-broker-types'
export {
  assertDevboxCredentialDeliveryPath,
  classifyDevboxCredentialDeclaration,
  isDevboxCredentialPathExcludedFromSync
}
export type {
  DevboxCredentialHostBinding,
  DevboxCredentialForwardedConnection,
  DevboxCredentialAtomicWriteRequest,
  DevboxCredentialAtomicWriteResult,
  DevboxCredentialIdentityRemovalRequest,
  DevboxCredentialTransport,
  DevboxCredentialProviderHost,
  DevboxCredentialProviderAuthorizationRequest,
  DevboxCredentialProviderAuthorizationResult,
  DevboxCredentialProviderAuthorizer,
  DevboxCredentialProviderRevoker,
  DevboxCredentialIdentity,
  DevboxCredentialIdentityGenerator,
  DevboxCredentialOAuthAuthorization,
  DevboxCredentialOAuthBridge,
  DevboxCredentialProbeObservation,
  DevboxCredentialProbe,
  DevboxCredentialBrokerAuditEvent,
  DevboxCredentialBrokerOptions,
  DevboxCredentialDeliveryFailure,
  DevboxCredentialEnrollmentResult,
  DevboxCredentialProviderAuthorizationSummary,
  DevboxCredentialOAuthResult,
  DevboxCredentialRevokeResult
} from './devbox-credential-broker-types'

export class DevboxCredentialBroker {
  private readonly capabilitiesByRef = new Map<string, DevboxCredentialCapability>()
  private readonly machineEnrollments = new Map<string, MachineEnrollmentState>()
  private readonly oauthStates = new Map<string, OAuthState>()
  private readonly forwardedConnections = new Map<string, boolean>()
  private readonly options: DevboxCredentialBrokerOptions
  private readonly redactor: DevboxRedactor

  constructor(options: DevboxCredentialBrokerOptions) {
    if (!isText(options.profileId) || !isText(options.targetId)) {
      throw new TypeError(
        'Devbox credential broker requires opaque profile and target identifiers.'
      )
    }
    this.options = options
    this.redactor = options.redactor ?? new DevboxRedactor()
  }

  registerCapability(capability: DevboxCredentialCapability): DevboxCredentialCapability {
    this.capabilitiesByRef.set(capability.capabilityRef, capability)
    if (capability.class === 'oauth-per-host') {
      this.oauthStates.set(capability.capabilityRef, { capability })
    }
    return capability
  }

  registerDeclarations(
    declarations: readonly DevboxCredentialCapabilityDeclaration[],
    options: Readonly<{ connected?: boolean }> = {}
  ): readonly DevboxCredentialCapability[] {
    return [...declarations]
      .sort((a, b) => a.referenceId.localeCompare(b.referenceId))
      .map((declaration) =>
        this.registerCapability(
          capabilityForDeclaration(declaration, { ...options, targetId: this.options.targetId })
        )
      )
  }

  capabilities(): readonly DevboxCredentialCapability[] {
    return [...this.capabilitiesByRef.values()].sort((a, b) =>
      a.capabilityRef.localeCompare(b.capabilityRef)
    )
  }

  getCapability(capabilityRef: string): DevboxCredentialCapability | undefined {
    return this.capabilitiesByRef.get(capabilityRef)
  }

  updateForwardedConnection(
    capabilityRef: string,
    connection: DevboxCredentialForwardedConnection
  ): DevboxCredentialCapability | undefined {
    const current = this.capabilitiesByRef.get(capabilityRef)
    if (!current || current.class !== 'forwarded-only') {
      return undefined
    }
    if (current.connectionRef !== connection.connectionRef) {
      return undefined
    }
    this.forwardedConnections.set(
      connection.connectionRef,
      connection.connected && connection.agentForwarding
    )
    const next = capabilityStatus(
      current,
      connection.connected && connection.agentForwarding ? 'available' : 'blocked'
    )
    this.capabilitiesByRef.set(capabilityRef, next)
    return next
  }

  disconnectForwardedConnection(connectionRef: DevboxCredentialHostReference): void {
    this.forwardedConnections.set(connectionRef, false)
    for (const [capabilityRef, capability] of this.capabilitiesByRef) {
      if (capability.class === 'forwarded-only' && capability.connectionRef === connectionRef) {
        this.capabilitiesByRef.set(capabilityRef, capabilityStatus(capability, 'blocked'))
      }
    }
  }

  async enrollMachineCredential(
    request: Readonly<{
      capabilityRef: DevboxCredentialCapabilityReference
      host: DevboxCredentialHostBinding
      targetPath: string
      secret: string
      explicitEnrollment: boolean
      /** Optional separate path for the generated Devbox SSH identity. */
      identityPath?: string
      sourcePath?: string
      providerHosts?: readonly DevboxCredentialProviderHost[]
    }>
  ): Promise<DevboxCredentialEnrollmentResult> {
    return enrollMachineCredential(this.context(), request)
  }

  async authorizeOAuth(
    request: Readonly<{
      capabilityRef: DevboxCredentialCapabilityReference
      host: DevboxCredentialHostBinding
      hostRef: DevboxCredentialHostReference
      bridgeCapability: unknown
    }>
  ): Promise<DevboxCredentialOAuthResult> {
    return authorizeOAuth(this.context(), request)
  }

  async revoke(
    capabilityRef: DevboxCredentialCapabilityReference,
    host?: DevboxCredentialHostBinding
  ): Promise<DevboxCredentialRevokeResult> {
    return this.revokeMachineCredential(capabilityRef, host)
  }

  async revokeMachineCredential(
    capabilityRef: DevboxCredentialCapabilityReference,
    host?: DevboxCredentialHostBinding
  ): Promise<DevboxCredentialRevokeResult> {
    return revokeMachineCredential(this.context(), capabilityRef, host)
  }

  async probeCapability(
    capabilityRef: DevboxCredentialCapabilityReference
  ): Promise<DevboxCredentialProbeObservation> {
    return probeCapability(this.context(), capabilityRef)
  }

  private context(): DevboxCredentialBrokerContext {
    return {
      options: this.options,
      capabilitiesByRef: this.capabilitiesByRef,
      machineEnrollments: this.machineEnrollments,
      oauthStates: this.oauthStates,
      forwardedConnections: this.forwardedConnections,
      deliveryBlock: (host) => this.deliveryBlock(host),
      blockedDelivery: (capability, reason) => this.blockedDelivery(capability, reason),
      failure: (status, reason, nextStep) => this.failure(status, reason, nextStep),
      audit: (event) => this.audit(event)
    }
  }

  private deliveryBlock(
    host: DevboxCredentialHostBinding
  ): DevboxCredentialDeliveryFailure['reason'] | undefined {
    if (!host.profileTrusted) {
      return 'profile-untrusted'
    }
    if (
      host.expected.host !== host.observed.host ||
      host.expected.port !== host.observed.port ||
      host.expected.username !== host.observed.username
    ) {
      return 'endpoint-changed'
    }
    if (host.expected.hostKeyFingerprint !== host.observed.hostKeyFingerprint) {
      return 'host-key-changed'
    }
    return undefined
  }

  private blockedDelivery(
    capability: DevboxCredentialCapability,
    reason: NonNullable<DevboxCredentialDeliveryFailure['reason']>
  ): DevboxCredentialDeliveryFailure {
    const message =
      reason === 'profile-untrusted'
        ? 'Verify and trust the Devbox profile before delivering credentials.'
        : reason === 'host-key-changed'
          ? 'Re-verify the exact SSH host key before delivering credentials.'
          : 'Re-verify the Devbox endpoint before delivering credentials.'
    this.capabilitiesByRef.set(capability.capabilityRef, capabilityStatus(capability, 'blocked'))
    this.audit({
      action: 'delivery-blocked',
      profileId: this.options.profileId,
      targetId: this.options.targetId,
      capabilityRef: capability.capabilityRef,
      status: 'blocked',
      reason
    })
    return this.failure('blocked', reason, message)
  }

  private failure(
    status: DevboxCredentialDeliveryFailure['status'],
    reason: DevboxCredentialDeliveryFailure['reason'],
    nextStep: string
  ): DevboxCredentialDeliveryFailure {
    return { ok: false, status, reason, nextStep }
  }

  private audit(event: DevboxCredentialBrokerAuditEvent): void {
    if (!this.options.audit) {
      return
    }
    const safe = this.redactor.redactForTarget(event, 'log').value
    this.options.audit(safe as DevboxRedactionBoundary | Record<string, unknown>)
  }
}

export function isPrimaryDevboxSshPrivateKeyPath(path: string): boolean {
  return isPrimarySshPrivateKeyPath(path)
}
