import { describe, expect, it } from 'vitest'
import {
  canUseDevboxBridgeCapability,
  DEVBOX_BRIDGE_MAX_TTL_MS,
  issueDevboxBridgeCapability,
  isDevboxBridgeCapability,
  type DevboxManagedBridgeSession
} from './devbox-bridge-capabilities'
import type { DevboxAuthorityEpoch } from './devbox-types'

const session: DevboxManagedBridgeSession = {
  kind: 'managed-phi-session',
  profileId: 'profile-1',
  targetId: 'target-1',
  sessionId: 'phi-session-1',
  relayEpoch: 'opaque-epoch' as DevboxAuthorityEpoch,
  sshIdentity: {
    host: 'devbox.example.test',
    port: 22,
    username: 'sample',
    hostKeyFingerprint: 'SHA256:abc123'
  }
}

describe('Devbox remote bridge capabilities', () => {
  it('gives detached jobs no capability', () => {
    expect(
      issueDevboxBridgeCapability(
        { kind: 'detached-job', profileId: 'profile-1', targetId: 'target-1' },
        { capabilityId: 'cap-1', now: 100 }
      )
    ).toEqual({ ok: false, reason: 'detached-job' })
  })

  it('uses the 30-minute remote MCP OAuth lease as the capability max TTL', () => {
    expect(DEVBOX_BRIDGE_MAX_TTL_MS).toBe(30 * 60_000)
    const result = issueDevboxBridgeCapability(session, {
      capabilityId: 'cap-1',
      now: 100,
      operations: ['prepare', 'open']
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(isDevboxBridgeCapability(result.capability)).toBe(true)
      expect(result.capability.scope).toBe('remote-mcp-oauth')
      expect(result.capability.operations).toEqual(['prepare', 'open'])
      expect(
        canUseDevboxBridgeCapability(
          result.capability,
          'prepare',
          100 + DEVBOX_BRIDGE_MAX_TTL_MS - 1
        )
      ).toEqual({ ok: true })
      expect(canUseDevboxBridgeCapability(result.capability, 'close', 500)).toEqual({
        ok: false,
        reason: 'operation-denied'
      })
      expect(
        canUseDevboxBridgeCapability(result.capability, 'prepare', 100 + DEVBOX_BRIDGE_MAX_TTL_MS)
      ).toEqual({
        ok: false,
        reason: 'expired'
      })
    }
  })
})
