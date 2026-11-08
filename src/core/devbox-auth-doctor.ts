import type {
  DevboxCredentialCapability,
  DevboxCredentialCapabilityReference
} from './devbox-credential-types'
import { DevboxRedactor, type DevboxRedactionBoundary } from './devbox-redactor'
import { redactedDevboxValue } from '../shared/devbox-errors'
import type {
  DevboxCredentialProbe,
  DevboxCredentialProbeObservation,
  DevboxCredentialBroker
} from './devbox-credential-broker'

export const DEVBOX_AUTH_DOCTOR_SCHEMA_VERSION = 1 as const

export type DevboxAuthDoctorStatus = 'healthy' | 'required' | 'expired' | 'unavailable'

export type DevboxAuthDoctorCapabilityResult = Readonly<{
  capabilityRef: DevboxCredentialCapabilityReference
  statusRef: string
  class: DevboxCredentialCapability['class']
  status: DevboxAuthDoctorStatus
  reachability: DevboxCredentialProbeObservation['reachability']
  authorization: DevboxCredentialProbeObservation['authorization']
  reason?: string
  nextStep: string
}>

export type DevboxAuthDoctorSummary = Readonly<{
  schemaVersion: typeof DEVBOX_AUTH_DOCTOR_SCHEMA_VERSION
  profileId: string
  targetId: string
  status: DevboxAuthDoctorStatus
  capabilities: readonly DevboxAuthDoctorCapabilityResult[]
  counts: Readonly<Record<DevboxAuthDoctorStatus, number>>
}>

export type DevboxAuthDoctorOptions = Readonly<{
  profileId: string
  targetId: string
  capabilities: readonly DevboxCredentialCapability[]
  probe?: DevboxCredentialProbe
  broker?: Pick<DevboxCredentialBroker, 'probeCapability'>
  redactor?: DevboxRedactor
}>

function reasonText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  return value
}

function nextStepFor(
  capability: DevboxCredentialCapability,
  status: DevboxAuthDoctorStatus,
  reason?: string
): string {
  if (status === 'healthy') {
    return 'No action required.'
  }
  if (reason === 'connection-disconnected') {
    return 'Reconnect the Devbox SSH connection or explicitly enroll a machine credential on the trusted remote host.'
  }
  if (
    reason === 'host-untrusted' ||
    reason === 'host-key-changed' ||
    reason === 'endpoint-changed'
  ) {
    return 'Re-verify the Devbox endpoint and exact SSH host key before delivering or probing credentials.'
  }
  if (
    reason === 'oauth-expired' ||
    status === 'expired' ||
    (capability.class === 'oauth-per-host' && status === 'required')
  ) {
    return 'Open the local browser to authorize this host again; rotating OAuth caches and lock files are never copied.'
  }
  if (
    reason === 'generated-machine-identity-revoked' ||
    reason === 'revoked' ||
    (status === 'unavailable' && capability.class === 'machine-enrolled')
  ) {
    return 'Revoke the provider-side identity if needed, then explicitly enroll a new generated Devbox identity.'
  }
  if (capability.class === 'machine-enrolled' && status === 'required') {
    return 'Explicitly enroll this credential on the verified remote host and authorize every required provider host.'
  }
  if (capability.class === 'forwarded-only') {
    return 'Reconnect the SSH agent-forwarding connection; this capability is intentionally unavailable while disconnected.'
  }
  if (capability.class === 'unavailable') {
    return 'Use a supported forwarded, machine-enrolled, or per-host OAuth capability; generic credential sync is blocked.'
  }
  return 'Complete the provider authorization step, then rerun devbox doctor.'
}

function statusFor(
  capability: DevboxCredentialCapability,
  observation: DevboxCredentialProbeObservation
): DevboxAuthDoctorStatus {
  if (capability.class === 'unavailable') {
    return 'unavailable'
  }
  if (observation.authorization === 'expired') {
    return 'expired'
  }
  if (observation.authorization === 'required') {
    return 'required'
  }
  if (observation.authorization === 'revoked') {
    return 'unavailable'
  }
  if (observation.reachability !== 'reachable' || observation.authorization !== 'authorized') {
    return 'unavailable'
  }
  return 'healthy'
}

const SAFE_PROBE_REASONS = new Set([
  'authorization-required',
  'capability-not-registered',
  'connection-disconnected',
  'generated-machine-identity-revoked',
  'host-key-changed',
  'host-untrusted',
  'endpoint-changed',
  'local-browser-bridge-failed',
  'oauth-expired',
  'probe-failed',
  'probe-unavailable',
  'provider-unsupported'
])

function safeReason(redactor: DevboxRedactor, value: unknown): string | undefined {
  const text = reasonText(value)
  if (!text) {
    return undefined
  }
  if (!SAFE_PROBE_REASONS.has(text)) {
    return redactedDevboxValue().value
  }
  const redacted = redactor.redact(text)
  if (typeof redacted === 'string') {
    return redacted
  }
  return (redacted as DevboxRedactionBoundary).value
}

function emptyCounts(): Record<DevboxAuthDoctorStatus, number> {
  return { healthy: 0, required: 0, expired: 0, unavailable: 0 }
}

/**
 * Runs value-free capability probes. The result deliberately has no observed
 * timestamps, URLs, token metadata, or provider response bodies, so the JSON
 * form is stable and suitable for `devbox doctor --json`.
 */
export class DevboxAuthDoctor {
  private readonly options: DevboxAuthDoctorOptions
  private readonly redactor: DevboxRedactor

  constructor(options: DevboxAuthDoctorOptions) {
    this.options = options
    this.redactor = options.redactor ?? new DevboxRedactor()
  }

  async run(): Promise<DevboxAuthDoctorSummary> {
    const capabilities = [...this.options.capabilities].sort((a, b) =>
      a.capabilityRef.localeCompare(b.capabilityRef)
    )
    const results: DevboxAuthDoctorCapabilityResult[] = []
    const counts = emptyCounts()
    for (const capability of capabilities) {
      const observation = await this.probe(capability)
      const status = statusFor(capability, observation)
      counts[status] += 1
      const reason = safeReason(
        this.redactor,
        capability.class === 'unavailable' ? capability.reason : observation.reason
      )
      results.push({
        capabilityRef: capability.capabilityRef,
        statusRef: capability.statusRef,
        class: capability.class,
        status,
        reachability: observation.reachability,
        authorization: observation.authorization,
        ...(reason ? { reason } : {}),
        nextStep: nextStepFor(capability, status, reason)
      })
    }
    const status =
      counts.unavailable > 0
        ? 'unavailable'
        : counts.expired > 0
          ? 'expired'
          : counts.required > 0
            ? 'required'
            : 'healthy'
    return {
      schemaVersion: DEVBOX_AUTH_DOCTOR_SCHEMA_VERSION,
      profileId: this.options.profileId,
      targetId: this.options.targetId,
      status,
      capabilities: results,
      counts
    }
  }

  async probeCapability(
    capabilityRef: DevboxCredentialCapabilityReference
  ): Promise<DevboxCredentialProbeObservation> {
    const capability = this.options.capabilities.find(
      (entry) => entry.capabilityRef === capabilityRef
    )
    if (!capability) {
      return {
        reachability: 'unknown',
        authorization: 'unknown',
        reason: 'capability-not-registered'
      }
    }
    return this.probe(capability)
  }

  async doctorJson(): Promise<string> {
    return formatDevboxAuthDoctorJson(await this.run())
  }

  private async probe(
    capability: DevboxCredentialCapability
  ): Promise<DevboxCredentialProbeObservation> {
    if (capability.class === 'unavailable') {
      return { reachability: 'unknown', authorization: 'unknown', reason: capability.reason }
    }
    const probe =
      this.options.probe ??
      (this.options.broker
        ? (request: Parameters<DevboxCredentialProbe>[0]) =>
            this.options.broker!.probeCapability(request.capabilityRef)
        : undefined)
    if (!probe) {
      return capability.status === 'available'
        ? { reachability: 'reachable', authorization: 'authorized' }
        : capability.status === 'expired'
          ? { reachability: 'reachable', authorization: 'expired', reason: 'oauth-expired' }
          : capability.status === 'required'
            ? {
                reachability: 'reachable',
                authorization: 'required',
                reason: 'authorization-required'
              }
            : { reachability: 'unknown', authorization: 'unknown', reason: 'probe-unavailable' }
    }
    try {
      return await probe({
        capabilityRef: capability.capabilityRef,
        class: capability.class,
        targetId: this.options.targetId
      })
    } catch {
      return { reachability: 'unknown', authorization: 'unknown', reason: 'probe-failed' }
    }
  }
}

export function formatDevboxAuthDoctorJson(summary: DevboxAuthDoctorSummary): string {
  return `${JSON.stringify(summary)}\n`
}

export function isDevboxAuthDoctorSummary(value: unknown): value is DevboxAuthDoctorSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === DEVBOX_AUTH_DOCTOR_SCHEMA_VERSION &&
    typeof record.profileId === 'string' &&
    typeof record.targetId === 'string' &&
    ['healthy', 'required', 'expired', 'unavailable'].includes(String(record.status)) &&
    Array.isArray(record.capabilities) &&
    typeof record.counts === 'object' &&
    record.counts !== null
  )
}
