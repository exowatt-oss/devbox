import { createDevboxError } from '../shared/devbox-errors'
import type {
  DevboxBridgeCapability,
  DevboxBridgeCapabilityUseResult
} from '../shared/devbox-bridge-capabilities'
import type { DevboxBridgeCapabilityBroker } from './devbox-bridge-capability-broker'

// Host applications embedding Devbox must allowlist this environment key.
export const DEVBOX_BRIDGE_CAPABILITY_ENV = 'DEVBOX_BRIDGE_CAPABILITY' as const

type RegisteredCapability = {
  broker: DevboxBridgeCapabilityBroker
  capability: DevboxBridgeCapability
}

const registeredById = new Map<string, RegisteredCapability[]>()

export function registerDevboxBridgeCapability(
  broker: DevboxBridgeCapabilityBroker,
  capability: DevboxBridgeCapability
): void {
  const registrations = registeredById.get(capability.capabilityId) ?? []
  const next = registrations.filter((item) => item.broker !== broker)
  next.push({ broker, capability })
  registeredById.set(capability.capabilityId, next)
}

export function unregisterDevboxBridgeCapability(
  broker: DevboxBridgeCapabilityBroker,
  capabilityId: string
): void {
  const registrations = registeredById.get(capabilityId)
  if (!registrations) {
    return
  }
  const next = registrations.filter((item) => item.broker !== broker)
  if (next.length === 0) {
    registeredById.delete(capabilityId)
  } else {
    registeredById.set(capabilityId, next)
  }
}

export function assertDevboxBridgeDispatchAuthorized(input: {
  targetId: string
  capability: unknown
  operation: string
  argv: readonly string[]
  now?: number
}): void {
  const capabilityId = capabilityIdFromUnknown(input.capability)
  const registration = capabilityId
    ? registeredById.get(capabilityId)?.find((item) => item.capability.targetId === input.targetId)
    : undefined
  if (!registration) {
    throw createDevboxError('bridge_denied', { context: { field: 'capability' } })
  }

  const result = registration.broker.authorize({
    capability: registration.capability,
    operation: input.operation,
    argv: input.argv,
    ...(input.now === undefined ? {} : { now: input.now })
  })
  if (result.ok) {
    return
  }
  if (result.reason === 'expired') {
    unregisterDevboxBridgeCapability(registration.broker, registration.capability.capabilityId)
  }
  throw bridgeError(result)
}

function capabilityIdFromUnknown(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('capabilityId' in value) ||
    typeof value.capabilityId !== 'string'
  ) {
    return null
  }
  return value.capabilityId
}

function bridgeError(result: Extract<DevboxBridgeCapabilityUseResult, { ok: false }>) {
  return createDevboxError(result.reason === 'expired' ? 'bridge_expired' : 'bridge_scope_denied', {
    context: { field: result.reason }
  })
}
