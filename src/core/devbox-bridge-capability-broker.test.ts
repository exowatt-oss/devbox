import { describe, expect, it } from 'vitest'
import { DevboxBridgeCapabilityBroker } from './devbox-bridge-capability-broker'
import type { DevboxAuthorityEpoch } from '../shared/devbox-types'
import { REMOTE_MCP_OAUTH_COMMAND } from '../shared/remote-mcp-oauth-contract'

const session = {
  kind: 'managed-phi-session' as const,
  profileId: 'profile-1',
  targetId: 'target-1',
  sessionId: 'phi-1',
  relayEpoch: 'epoch-1' as DevboxAuthorityEpoch,
  sshIdentity: {
    host: 'fixture',
    port: 22,
    username: 'user',
    hostKeyFingerprint: 'SHA256:x'
  }
}

describe('DevboxBridgeCapabilityBroker', () => {
  it('issues only an OAuth-scoped short-lived capability', () => {
    let now = 100
    const broker = new DevboxBridgeCapabilityBroker({
      now: () => now,
      id: () => 'cap-1'
    })
    const capability = broker.issueForPhi(session, 10_000)
    expect(capability.scope).toBe('remote-mcp-oauth')
    expect(
      broker.authorize({
        capability,
        operation: 'prepare',
        argv: [REMOTE_MCP_OAUTH_COMMAND]
      })
    ).toEqual({ ok: true })
    expect(
      broker.authorize({ capability, operation: 'local.exec', argv: ['sh', '-c', 'id'] })
    ).toMatchObject({ ok: false })
    expect(broker.authorize({ capability, operation: 'open', argv: ['local-file-read'] })).toEqual({
      ok: false,
      reason: 'operation-denied'
    })
    now = 20_000
    expect(
      broker.authorize({ capability, operation: 'prepare', argv: [REMOTE_MCP_OAUTH_COMMAND] })
    ).toEqual({ ok: false, reason: 'expired' })
  })

  it('does not issue a capability to detached jobs', () => {
    const broker = new DevboxBridgeCapabilityBroker({
      id: () => 'cap-1'
    })
    expect(() => broker.issueForDetachedJob()).toThrow()
    expect(broker.activeCount()).toBe(0)
  })
})
