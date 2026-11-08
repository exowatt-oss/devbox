import type {
  DevboxCredentialCapability,
  DevboxCredentialCapabilityReference,
  DevboxCredentialHostReference,
  DevboxCredentialStatusReference,
  DevboxCredentialStatusState
} from './devbox-credential-types'
import {
  classifyDevboxWorkspacePath,
  createDevboxCredentialCapabilityReference,
  createDevboxCredentialHostReference,
  createDevboxCredentialStatusReference
} from './devbox-credential-types'
import type { DevboxCredentialCapabilityDeclaration } from '../shared/devbox-types'

function reference(value: string, kind: 'capability' | 'status' | 'host'): string {
  if (kind === 'capability') {
    return createDevboxCredentialCapabilityReference(value)
  }
  if (kind === 'status') {
    return createDevboxCredentialStatusReference(value)
  }
  return createDevboxCredentialHostReference(value)
}

export function capabilityForDeclaration(
  declaration: DevboxCredentialCapabilityDeclaration,
  options: Readonly<{ targetId: string; connected?: boolean }>
): DevboxCredentialCapability {
  const capabilityRef = reference(
    declaration.referenceId,
    'capability'
  ) as DevboxCredentialCapabilityReference
  const statusRef = reference(
    `${declaration.referenceId}-status`,
    'status'
  ) as DevboxCredentialStatusReference
  if (declaration.kind === 'ssh-transport') {
    return {
      class: 'forwarded-only',
      capabilityRef,
      statusRef,
      status: options.connected ? 'available' : 'required',
      connectionRef: reference(
        `${declaration.targetId}-connection`,
        'host'
      ) as DevboxCredentialHostReference
    }
  }
  const hostRef = reference(options.targetId, 'host') as DevboxCredentialHostReference
  if (declaration.kind === 'mcp-oauth' || declaration.delivery === 'local-browser') {
    return {
      class: 'oauth-per-host',
      capabilityRef,
      statusRef,
      status: 'required',
      authorizationRef: reference(
        `${declaration.referenceId}-authorization`,
        'capability'
      ) as DevboxCredentialCapabilityReference,
      hostRef
    }
  }
  if (declaration.kind === 'provider-auth' && declaration.delivery === 'remote-enrollment') {
    return {
      class: 'machine-enrolled',
      capabilityRef,
      statusRef,
      status: 'required',
      enrollmentRef: reference(
        `${declaration.referenceId}-enrollment`,
        'capability'
      ) as DevboxCredentialCapabilityReference,
      hostRef
    }
  }
  return {
    class: 'unavailable',
    capabilityRef,
    statusRef,
    status: 'blocked',
    reason: 'provider-unsupported'
  }
}

export function classifyDevboxCredentialDeclaration(
  declaration: DevboxCredentialCapabilityDeclaration,
  options: Readonly<{ targetId: string; connected?: boolean }>
): DevboxCredentialCapability {
  return capabilityForDeclaration(declaration, options)
}

export function isDevboxCredentialPathExcludedFromSync(path: string): boolean {
  const normalized = path.trim().replaceAll('\\', '/')
  return (
    classifyDevboxWorkspacePath(normalized).class === 'excluded-from-generic-sync' ||
    /(?:^|\/)\.mcp-auth(?:\/|$)/i.test(normalized) ||
    /_lock\.json$/i.test(normalized)
  )
}

export function assertDevboxCredentialDeliveryPath(path: string): void {
  if (
    !isText(path) ||
    path.includes('\u0000') ||
    path.split(/[\\/]/u).some((part) => part === '..')
  ) {
    throw new TypeError('Devbox credential destination must be a safe, explicit remote path.')
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

export function capabilityStatus(
  capability: DevboxCredentialCapability,
  status: DevboxCredentialStatusState
): DevboxCredentialCapability {
  return { ...capability, status } as DevboxCredentialCapability
}
