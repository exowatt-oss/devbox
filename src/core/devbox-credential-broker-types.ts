import type { DevboxBridgeCapability } from '../shared/devbox-bridge-capabilities'
import type {
  DevboxCredentialCapability,
  DevboxCredentialCapabilityReference,
  DevboxCredentialHostReference,
  DevboxCredentialStatusState
} from './devbox-credential-types'
import type { DevboxRedactor } from './devbox-redactor'
import type { DevboxSshIdentity } from '../shared/devbox-types'

export const DEVBOX_CREDENTIAL_FILE_MODE = 0o600 as const
export const DEVBOX_OAUTH_CACHE_EXCLUSION_GLOB = '~/.mcp-auth/**' as const
export const DEVBOX_OAUTH_LOCK_SUFFIX = '_lock.json' as const

export type DevboxCredentialHostBinding = Readonly<{
  profileTrusted: boolean
  expected: DevboxSshIdentity
  observed: DevboxSshIdentity
}>

export type DevboxCredentialForwardedConnection = Readonly<{
  connectionRef: DevboxCredentialHostReference
  connected: boolean
  agentForwarding: boolean
}>

export type DevboxCredentialAtomicWriteRequest = Readonly<{
  kind: 'atomic-secret-write'
  targetPath: string
  stdin: string
  argv: readonly []
  env: Readonly<Record<never, never>>
  mode: typeof DEVBOX_CREDENTIAL_FILE_MODE
  atomic: true
}>

export type DevboxCredentialAtomicWriteResult = Readonly<{
  ok: boolean
  atomic: boolean
  mode: number
  targetPath: string
}>

export type DevboxCredentialIdentityRemovalRequest = Readonly<{
  kind: 'remove-generated-identity'
  targetPath: string
  identityRef: string
  argv: readonly []
  env: Readonly<Record<never, never>>
}>

export type DevboxCredentialTransport = Readonly<{
  writeSecretAtomically(
    request: DevboxCredentialAtomicWriteRequest
  ): Promise<DevboxCredentialAtomicWriteResult>
  removeGeneratedIdentity(request: DevboxCredentialIdentityRemovalRequest): Promise<{ ok: boolean }>
}>

export type DevboxCredentialProviderHost = Readonly<{
  provider: 'github' | 'gitlab' | 'custom'
  host: string
  revokeInstructions?: string
}>

export type DevboxCredentialProviderAuthorizationRequest = Readonly<{
  provider: DevboxCredentialProviderHost['provider']
  host: string
  identityRef: string
  publicKey: string
}>

export type DevboxCredentialProviderAuthorizationResult = Readonly<{
  status: 'authorized' | 'required' | 'unavailable'
  revokeInstructions?: string
}>

export type DevboxCredentialProviderAuthorizer = (
  request: DevboxCredentialProviderAuthorizationRequest
) => Promise<DevboxCredentialProviderAuthorizationResult>

export type DevboxCredentialProviderRevoker = (request: {
  provider: DevboxCredentialProviderHost['provider']
  host: string
  identityRef: string
}) => Promise<{ ok: boolean }>

export type DevboxCredentialIdentity = Readonly<{
  identityRef: string
  publicKey: string
  privateKey: string
}>

export type DevboxCredentialIdentityGenerator = () => DevboxCredentialIdentity

export type DevboxCredentialOAuthAuthorization = Readonly<{
  status: 'authorized' | 'required' | 'expired' | 'unavailable'
  reason?: string
}>

export type DevboxCredentialOAuthBridge = (
  request: Readonly<{
    capability: DevboxBridgeCapability
    hostRef: DevboxCredentialHostReference
  }>
) => Promise<DevboxCredentialOAuthAuthorization>

export type DevboxCredentialProbeObservation = Readonly<{
  reachability: 'reachable' | 'unreachable' | 'unknown'
  authorization: 'authorized' | 'required' | 'expired' | 'revoked' | 'unknown'
  reason?: string
}>

export type DevboxCredentialProbe = (
  request: Readonly<{
    capabilityRef: DevboxCredentialCapabilityReference
    class: DevboxCredentialCapability['class']
    targetId: string
  }>
) => Promise<DevboxCredentialProbeObservation>

export type DevboxCredentialBrokerAuditEvent = Readonly<{
  action:
    | 'delivery-blocked'
    | 'secret-delivered'
    | 'provider-authorized'
    | 'oauth-authorized'
    | 'auth-revoked'
  profileId: string
  targetId: string
  capabilityRef: string
  status: DevboxCredentialStatusState
  reason?: string
  identityRef?: string
  provider?: string
  host?: string
}>

export type DevboxCredentialBrokerOptions = Readonly<{
  profileId: string
  targetId: string
  transport: DevboxCredentialTransport
  providerAuthorizer?: DevboxCredentialProviderAuthorizer
  providerRevoker?: DevboxCredentialProviderRevoker
  identityGenerator?: DevboxCredentialIdentityGenerator
  oauthBridge?: DevboxCredentialOAuthBridge
  probe?: DevboxCredentialProbe
  now?: () => number
  redactor?: DevboxRedactor
  audit?: (event: unknown) => void
}>

export type DevboxCredentialDeliveryFailure = Readonly<{
  ok: false
  status: 'blocked' | 'required' | 'unavailable'
  reason:
    | 'profile-untrusted'
    | 'endpoint-changed'
    | 'host-key-changed'
    | 'primary-key-forbidden'
    | 'enrollment-not-explicit'
    | 'transport-failed'
    | 'provider-authorization-failed'
    | 'bridge-denied'
    | 'revoked'
  nextStep: string
}>

export type DevboxCredentialProviderAuthorizationSummary = Readonly<{
  provider: DevboxCredentialProviderHost['provider']
  host: string
  status: 'authorized' | 'required' | 'unavailable'
  revokeInstructions: string
}>

export type DevboxCredentialEnrollmentResult =
  | Readonly<{
      ok: true
      capability: DevboxCredentialCapability
      identityRef: string
      providerAuthorizations: readonly DevboxCredentialProviderAuthorizationSummary[]
      revokeInstructions: readonly string[]
    }>
  | DevboxCredentialDeliveryFailure

export type DevboxCredentialOAuthResult =
  | Readonly<{ ok: true; capability: DevboxCredentialCapability }>
  | DevboxCredentialDeliveryFailure

export type DevboxCredentialRevokeResult = Readonly<{
  ok: boolean
  capability: DevboxCredentialCapability
  remoteRemoval: 'completed' | 'unavailable' | 'not-required'
  providerRevocations: readonly Readonly<{
    provider: string
    host: string
    status: 'completed' | 'unavailable' | 'not-required'
  }>[]
  revokeInstructions: readonly string[]
}>

export type MachineEnrollmentState = {
  capability: DevboxCredentialCapability & { class: 'machine-enrolled' }
  identityRef: string
  targetPath: string
  identityPath: string
  providerHosts: readonly DevboxCredentialProviderHost[]
  revoked: boolean
  revokeInstructions: readonly string[]
}

export type OAuthState = {
  capability: DevboxCredentialCapability & { class: 'oauth-per-host' }
}

export type DevboxCredentialEnrollmentRequest = Readonly<{
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

export type DevboxCredentialOAuthRequest = Readonly<{
  capabilityRef: DevboxCredentialCapabilityReference
  host: DevboxCredentialHostBinding
  hostRef: DevboxCredentialHostReference
  bridgeCapability: unknown
}>

export type DevboxCredentialBrokerContext = {
  options: DevboxCredentialBrokerOptions
  capabilitiesByRef: Map<string, DevboxCredentialCapability>
  machineEnrollments: Map<string, MachineEnrollmentState>
  oauthStates: Map<string, OAuthState>
  forwardedConnections: Map<string, boolean>
  deliveryBlock(
    host: DevboxCredentialHostBinding
  ): DevboxCredentialDeliveryFailure['reason'] | undefined
  blockedDelivery(
    capability: DevboxCredentialCapability,
    reason: NonNullable<DevboxCredentialDeliveryFailure['reason']>
  ): DevboxCredentialDeliveryFailure
  failure(
    status: DevboxCredentialDeliveryFailure['status'],
    reason: DevboxCredentialDeliveryFailure['reason'],
    nextStep: string
  ): DevboxCredentialDeliveryFailure
  audit(event: DevboxCredentialBrokerAuditEvent): void
}
