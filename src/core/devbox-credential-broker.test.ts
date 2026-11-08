import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { issueDevboxBridgeCapability } from '../shared/devbox-bridge-capabilities'
import type { DevboxAuthorityEpoch, DevboxSshIdentity } from '../shared/devbox-types'
import {
  createDevboxCredentialCapabilityReference,
  createDevboxCredentialHostReference,
  createDevboxCredentialStatusReference,
  type DevboxCredentialCapability
} from './devbox-credential-types'
import {
  DEVBOX_CREDENTIAL_FILE_MODE,
  DevboxCredentialBroker,
  isDevboxCredentialPathExcludedFromSync,
  isPrimaryDevboxSshPrivateKeyPath,
  type DevboxCredentialAtomicWriteRequest,
  type DevboxCredentialHostBinding
} from './devbox-credential-broker'

const CANARY = 'synthetic-devbox-canary-credential-7f2a'
const expectedIdentity: DevboxSshIdentity = {
  host: 'devbox.synthetic.test',
  port: 22,
  username: 'tester',
  hostKeyFingerprint: 'SHA256:synthetic-host-key'
}
const hostBinding: DevboxCredentialHostBinding = {
  profileTrusted: true,
  expected: expectedIdentity,
  observed: expectedIdentity
}
const machineRef = createDevboxCredentialCapabilityReference('github-machine')
const machineCapability: DevboxCredentialCapability = {
  class: 'machine-enrolled',
  capabilityRef: machineRef,
  statusRef: createDevboxCredentialStatusReference('github-machine-status'),
  status: 'required',
  enrollmentRef: createDevboxCredentialCapabilityReference('github-machine-enrollment'),
  hostRef: createDevboxCredentialHostReference('devbox-synthetic')
}

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'devbox-credentials-'))
  const writes: DevboxCredentialAtomicWriteRequest[] = []
  const removals: string[] = []
  const audit: unknown[] = []
  const transport = {
    async writeSecretAtomically(request: DevboxCredentialAtomicWriteRequest) {
      writes.push(request)
      mkdirSync(join(root, 'remote'), { recursive: true })
      const temporary = `${join(root, 'remote', 'pending')}.${writes.length}.tmp`
      writeFileSync(temporary, request.stdin, { encoding: 'utf8', mode: request.mode })
      renameSync(temporary, request.targetPath)
      return {
        ok: true,
        atomic: true,
        mode: statSync(request.targetPath).mode & 0o777,
        targetPath: request.targetPath
      } as const
    },
    async removeGeneratedIdentity(request: { targetPath: string }) {
      removals.push(request.targetPath)
      return { ok: true }
    }
  }
  const broker = new DevboxCredentialBroker({
    profileId: 'profile-synthetic',
    targetId: 'target-synthetic',
    transport,
    identityGenerator: () => ({
      identityRef: 'devbox-identity-synthetic',
      publicKey: 'ssh-ed25519 synthetic-public-key',
      privateKey: 'synthetic-generated-private-key'
    }),
    providerAuthorizer: async ({ provider, host, publicKey }) => {
      expect(provider).toBe('github')
      expect(host).toBe('github.synthetic.test')
      expect(publicKey).toContain('synthetic-public-key')
      return { status: 'authorized' as const }
    },
    providerRevoker: async () => ({ ok: true }),
    audit: (event) => audit.push(event)
  })
  broker.registerCapability(machineCapability)
  return { root, writes, removals, audit, transport, broker }
}

describe('DevboxCredentialBroker', () => {
  it('delivers synthetic credentials through stdin only with atomic mode 0600 writes', async () => {
    const harness = makeHarness()
    const credentialPath = join(harness.root, 'remote', 'github-token')
    const identityPath = join(harness.root, 'remote', 'devbox-identity')
    const result = await harness.broker.enrollMachineCredential({
      capabilityRef: machineRef,
      host: hostBinding,
      targetPath: credentialPath,
      identityPath,
      secret: CANARY,
      explicitEnrollment: true,
      providerHosts: [{ provider: 'github', host: 'github.synthetic.test' }]
    })

    expect(result).toMatchObject({ ok: true, identityRef: 'devbox-identity-synthetic' })
    expect(harness.writes).toHaveLength(2)
    expect(harness.writes.map((write) => write.stdin)).toContain(CANARY)
    expect(
      harness.writes.every(
        (write) => write.argv.length === 0 && Object.keys(write.env).length === 0
      )
    ).toBe(true)
    expect(
      harness.writes.every((write) => write.mode === DEVBOX_CREDENTIAL_FILE_MODE && write.atomic)
    ).toBe(true)
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600)
    expect(statSync(identityPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(credentialPath, 'utf8')).toBe(CANARY)
    expect(readFileSync(identityPath, 'utf8')).toBe('synthetic-generated-private-key')
    expect(JSON.stringify(harness.audit)).not.toContain(CANARY)
  })

  it('structurally refuses the primary laptop SSH key path before any transfer', async () => {
    const harness = makeHarness()
    const result = await harness.broker.enrollMachineCredential({
      capabilityRef: machineRef,
      host: hostBinding,
      targetPath: join(harness.root, 'remote', 'credential'),
      secret: CANARY,
      sourcePath: '/Users/tester/.ssh/id_ed25519',
      explicitEnrollment: true
    })

    expect(result).toMatchObject({ ok: false, reason: 'primary-key-forbidden' })
    const materialResult = await harness.broker.enrollMachineCredential({
      capabilityRef: machineRef,
      host: hostBinding,
      targetPath: join(harness.root, 'remote', 'credential-2'),
      secret: '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----\\nsynthetic\\n-----END ' + 'OPENSSH PRIVATE' + ' KEY-----',
      explicitEnrollment: true
    })
    expect(materialResult).toMatchObject({ ok: false, reason: 'primary-key-forbidden' })
    expect(harness.writes).toHaveLength(0)
    expect(isPrimaryDevboxSshPrivateKeyPath('/Users/tester/.ssh/id_ed25519')).toBe(true)
    expect(isPrimaryDevboxSshPrivateKeyPath('/Users/tester/.ssh/id_ed25519.pub')).toBe(false)
  })

  it('blocks delivery for an untrusted profile or changed endpoint/host key', async () => {
    const harness = makeHarness()
    const changedEndpoint = {
      ...hostBinding,
      observed: { ...expectedIdentity, port: 2200 }
    }
    const changedKey = {
      ...hostBinding,
      observed: { ...expectedIdentity, hostKeyFingerprint: 'SHA256:changed' }
    }
    const untrusted = { ...hostBinding, profileTrusted: false }
    for (const host of [untrusted, changedEndpoint, changedKey]) {
      const result = await harness.broker.enrollMachineCredential({
        capabilityRef: machineRef,
        host,
        targetPath: join(harness.root, 'remote', 'credential'),
        secret: CANARY,
        explicitEnrollment: true
      })
      expect(result.ok).toBe(false)
    }
    expect(harness.writes).toHaveLength(0)
    expect(JSON.stringify(harness.audit)).not.toContain(CANARY)
  })

  it('degrades forwarded-only capabilities after disconnect', async () => {
    const forwardedRef = createDevboxCredentialCapabilityReference('ssh-forwarded')
    const connectionRef = createDevboxCredentialHostReference('connection-synthetic')
    const harness = makeHarness()
    harness.broker.registerCapability({
      class: 'forwarded-only',
      capabilityRef: forwardedRef,
      statusRef: createDevboxCredentialStatusReference('ssh-forwarded-status'),
      status: 'available',
      connectionRef
    })
    harness.broker.updateForwardedConnection(forwardedRef, {
      connectionRef,
      connected: true,
      agentForwarding: true
    })
    await expect(harness.broker.probeCapability(forwardedRef)).resolves.toMatchObject({
      reachability: 'reachable',
      authorization: 'authorized'
    })
    harness.broker.disconnectForwardedConnection(connectionRef)
    await expect(harness.broker.probeCapability(forwardedRef)).resolves.toMatchObject({
      reachability: 'unreachable',
      authorization: 'unknown',
      reason: 'connection-disconnected'
    })
  })

  it('uses the scoped existing bridge for OAuth and never accepts a lock/cache path', async () => {
    const oauthRef = createDevboxCredentialCapabilityReference('mcp-oauth-synthetic')
    const hostRef = createDevboxCredentialHostReference('devbox-synthetic')
    const harness = makeHarness()
    harness.broker.registerCapability({
      class: 'oauth-per-host',
      capabilityRef: oauthRef,
      statusRef: createDevboxCredentialStatusReference('mcp-oauth-status'),
      status: 'required',
      authorizationRef: createDevboxCredentialCapabilityReference('mcp-oauth-authorization'),
      hostRef
    })
    const issued = issueDevboxBridgeCapability(
      {
        kind: 'managed-phi-session',
        profileId: 'profile-synthetic',
        targetId: 'target-synthetic',
        sessionId: 'session-synthetic',
        relayEpoch: 'epoch-synthetic' as DevboxAuthorityEpoch,
        sshIdentity: expectedIdentity
      },
      {
        capabilityId: 'capability-synthetic',
        now: 1000
      }
    )
    expect(issued.ok).toBe(true)
    const oauthBridgeCalls: unknown[] = []
    const broker = new DevboxCredentialBroker({
      profileId: 'profile-synthetic',
      targetId: 'target-synthetic',
      transport: harness.transport,
      now: () => 1000,
      oauthBridge: async (request) => {
        oauthBridgeCalls.push(request)
        return { status: 'authorized' as const }
      }
    })
    broker.registerCapability({
      class: 'oauth-per-host',
      capabilityRef: oauthRef,
      statusRef: createDevboxCredentialStatusReference('mcp-oauth-status'),
      status: 'required',
      authorizationRef: createDevboxCredentialCapabilityReference('mcp-oauth-authorization'),
      hostRef
    })
    const result = await broker.authorizeOAuth({
      capabilityRef: oauthRef,
      host: hostBinding,
      hostRef,
      bridgeCapability: issued.ok ? issued.capability : null
    })
    expect(result.ok).toBe(true)
    expect(oauthBridgeCalls).toHaveLength(1)
    expect(isDevboxCredentialPathExcludedFromSync('.mcp-auth/provider/session_lock.json')).toBe(
      true
    )
    expect(
      isDevboxCredentialPathExcludedFromSync('/home/tester/.mcp-auth/provider/token.json')
    ).toBe(true)
    expect(isDevboxCredentialPathExcludedFromSync('workspace/plain-source.ts')).toBe(false)
  })

  it('invalidates generated identity on audited revoke and probes fail afterward', async () => {
    const harness = makeHarness()
    const credentialPath = join(harness.root, 'remote', 'credential')
    const enrolled = await harness.broker.enrollMachineCredential({
      capabilityRef: machineRef,
      host: hostBinding,
      targetPath: credentialPath,
      secret: CANARY,
      explicitEnrollment: true,
      providerHosts: [{ provider: 'github', host: 'github.synthetic.test' }]
    })
    expect(enrolled.ok).toBe(true)
    await expect(harness.broker.probeCapability(machineRef)).resolves.toMatchObject({
      authorization: 'authorized'
    })
    const revoked = await harness.broker.revokeMachineCredential(machineRef, hostBinding)
    expect(revoked.ok).toBe(true)
    expect(revoked.remoteRemoval).toBe('completed')
    expect(revoked.revokeInstructions[0]).toContain('github.synthetic.test')
    expect(harness.removals).toContain(`${credentialPath}.devbox-identity`)
    await expect(harness.broker.probeCapability(machineRef)).resolves.toMatchObject({
      authorization: 'revoked',
      reason: 'generated-machine-identity-revoked'
    })
    expect(JSON.stringify(harness.audit)).not.toContain(CANARY)
  })
})
