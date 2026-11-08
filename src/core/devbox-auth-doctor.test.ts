import { describe, expect, it } from 'vitest'
import {
  createDevboxCredentialCapabilityReference,
  createDevboxCredentialHostReference,
  createDevboxCredentialStatusReference,
  type DevboxCredentialCapability
} from './devbox-credential-types'
import {
  DevboxAuthDoctor,
  formatDevboxAuthDoctorJson,
  isDevboxAuthDoctorSummary
} from './devbox-auth-doctor'

const CANARY = 'synthetic-devbox-canary-doctor-93ab'
const hostRef = createDevboxCredentialHostReference('host-synthetic')

function capabilities(): DevboxCredentialCapability[] {
  return [
    {
      class: 'oauth-per-host',
      capabilityRef: createDevboxCredentialCapabilityReference('oauth-expired'),
      statusRef: createDevboxCredentialStatusReference('oauth-expired-status'),
      status: 'expired',
      authorizationRef: createDevboxCredentialCapabilityReference('oauth-expired-auth'),
      hostRef
    },
    {
      class: 'forwarded-only',
      capabilityRef: createDevboxCredentialCapabilityReference('ssh-forwarded'),
      statusRef: createDevboxCredentialStatusReference('ssh-forwarded-status'),
      status: 'blocked',
      connectionRef: createDevboxCredentialHostReference('connection-synthetic')
    },
    {
      class: 'unavailable',
      capabilityRef: createDevboxCredentialCapabilityReference('unsupported-cloud'),
      statusRef: createDevboxCredentialStatusReference('unsupported-cloud-status'),
      status: 'blocked',
      reason: 'provider-unsupported'
    },
    {
      class: 'machine-enrolled',
      capabilityRef: createDevboxCredentialCapabilityReference('machine-healthy'),
      statusRef: createDevboxCredentialStatusReference('machine-healthy-status'),
      status: 'available',
      enrollmentRef: createDevboxCredentialCapabilityReference('machine-healthy-enrollment'),
      hostRef
    }
  ]
}

describe('DevboxAuthDoctor', () => {
  it('produces deterministic sorted JSON with actionable per-capability states', async () => {
    const doctor = new DevboxAuthDoctor({
      profileId: 'profile-synthetic',
      targetId: 'target-synthetic',
      capabilities: capabilities(),
      probe: async ({ capabilityRef }) => {
        if (capabilityRef === 'machine-healthy') {
          return { reachability: 'reachable', authorization: 'authorized' }
        }
        if (capabilityRef === 'oauth-expired') {
          return { reachability: 'reachable', authorization: 'expired', reason: 'oauth-expired' }
        }
        return { reachability: 'unreachable', authorization: 'unknown', reason: CANARY }
      }
    })
    const first = await doctor.run()
    const second = await doctor.run()
    expect(first).toEqual(second)
    expect(first.capabilities.map((entry) => entry.capabilityRef)).toEqual([
      'machine-healthy',
      'oauth-expired',
      'ssh-forwarded',
      'unsupported-cloud'
    ])
    expect(
      first.capabilities.find((entry) => entry.capabilityRef === 'machine-healthy')
    ).toMatchObject({
      status: 'healthy',
      reachability: 'reachable',
      authorization: 'authorized',
      nextStep: 'No action required.'
    })
    expect(
      first.capabilities.find((entry) => entry.capabilityRef === 'oauth-expired')
    ).toMatchObject({
      status: 'expired',
      nextStep: expect.stringContaining('local browser')
    })
    expect(
      first.capabilities.find((entry) => entry.capabilityRef === 'ssh-forwarded')
    ).toMatchObject({
      status: 'unavailable',
      reason: '[REDACTED]',
      nextStep: expect.stringContaining('Reconnect')
    })
    expect(first.counts).toEqual({ healthy: 1, required: 0, expired: 1, unavailable: 2 })
    expect(first.status).toBe('unavailable')

    const json = formatDevboxAuthDoctorJson(first)
    expect(json).not.toContain(CANARY)
    expect(json).toBe(formatDevboxAuthDoctorJson(second))
    expect(isDevboxAuthDoctorSummary(JSON.parse(json))).toBe(true)
  })

  it('reports required machine authorization and disconnected forwarding without secret details', async () => {
    const requiredMachine: DevboxCredentialCapability = {
      class: 'machine-enrolled',
      capabilityRef: createDevboxCredentialCapabilityReference('machine-required'),
      statusRef: createDevboxCredentialStatusReference('machine-required-status'),
      status: 'required',
      enrollmentRef: createDevboxCredentialCapabilityReference('machine-required-enrollment'),
      hostRef
    }
    const doctor = new DevboxAuthDoctor({
      profileId: 'profile-synthetic',
      targetId: 'target-synthetic',
      capabilities: [requiredMachine],
      probe: async () => ({
        reachability: 'reachable',
        authorization: 'required',
        reason: 'authorization-required'
      })
    })
    await expect(doctor.doctorJson()).resolves.toContain('Explicitly enroll')
    await expect(doctor.probeCapability(requiredMachine.capabilityRef)).resolves.toEqual({
      reachability: 'reachable',
      authorization: 'required',
      reason: 'authorization-required'
    })
  })

  it('maps a revoked machine identity to unavailable with a recovery action', async () => {
    const revoked: DevboxCredentialCapability = {
      class: 'machine-enrolled',
      capabilityRef: createDevboxCredentialCapabilityReference('machine-revoked'),
      statusRef: createDevboxCredentialStatusReference('machine-revoked-status'),
      status: 'revoked',
      enrollmentRef: createDevboxCredentialCapabilityReference('machine-revoked-enrollment'),
      hostRef
    }
    const summary = await new DevboxAuthDoctor({
      profileId: 'profile-synthetic',
      targetId: 'target-synthetic',
      capabilities: [revoked],
      probe: async () => ({
        reachability: 'reachable',
        authorization: 'revoked',
        reason: 'generated-machine-identity-revoked'
      })
    }).run()
    expect(summary.capabilities[0]).toMatchObject({
      status: 'unavailable',
      nextStep: expect.stringContaining('provider-side')
    })
  })
})
