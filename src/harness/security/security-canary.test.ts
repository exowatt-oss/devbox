import { collectBundle } from '../../core/diagnostics-bundle'
import { DevboxAuthDoctor } from '../../core/devbox-auth-doctor'
import {
  DevboxCredentialBroker,
  type DevboxCredentialAtomicWriteRequest
} from '../../core/devbox-credential-broker'
import { DevboxConfigMaterializer } from '../../core/devbox-config-materializer'
import { DevboxOperationJournal } from '../../core/devbox-operation-journal'
import { createProvisionOperation } from '../../core/devbox-provisioner-operations'
import type { DevboxProvisionerContext } from '../../core/devbox-provisioner-operations'
import { DevboxJobLogStore } from '../../core/devbox-job-logs'
import { issueDevboxBridgeCapability } from '../../shared/devbox-bridge-capabilities'
import type { DevboxAuthorityEpoch, DevboxProfileV1 } from '../../shared/devbox-types'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SECURITY_CANARIES,
  SECURITY_HOST_BINDING,
  SECURITY_HOST_IDENTITY,
  SECURITY_PROVIDER_HOST,
  allSecurityCanaries
} from './security-corpus'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devbox-security-'))
  roots.push(value)
  return value
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Map) {
      return { map: [...entry.entries()] }
    }
    if (entry instanceof Set) {
      return { set: [...entry.values()] }
    }
    if (typeof entry === 'bigint') {
      return String(entry)
    }
    return entry
  })
}

function expectNoCanary(value: unknown): void {
  const output = typeof value === 'string' ? value : stringify(value)
  for (const canary of allSecurityCanaries()) {
    expect(output).not.toContain(canary)
  }
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe('Devbox credential security harness', () => {
  it('scans every product sink after realistic credential operations', async () => {
    const fixtureRoot = root()
    const remoteRoot = join(fixtureRoot, 'remote')
    const writes: DevboxCredentialAtomicWriteRequest[] = []
    const productLogs: unknown[] = []
    const transport = {
      async writeSecretAtomically(request: DevboxCredentialAtomicWriteRequest) {
        writes.push(request)
        mkdirSync(dirname(request.targetPath), { recursive: true })
        const temporary = `${request.targetPath}.${writes.length}.tmp`
        writeFileSync(temporary, request.stdin, { mode: request.mode })
        renameSync(temporary, request.targetPath)
        return {
          ok: true,
          atomic: true,
          mode: statSync(request.targetPath).mode & 0o777,
          targetPath: request.targetPath
        } as const
      },
      async removeGeneratedIdentity() {
        return { ok: true }
      }
    }
    const broker = new DevboxCredentialBroker({
      profileId: 'security-profile',
      targetId: 'security-target',
      transport,
      identityGenerator: () => ({
        identityRef: 'security-generated-identity',
        publicKey: 'ssh-ed25519 security-fixture-public-key',
        privateKey: SECURITY_CANARIES.generatedPrivateKey
      }),
      providerAuthorizer: async () => ({ status: 'authorized' as const }),
      oauthBridge: async () => ({
        status: 'unavailable' as const,
        reason: SECURITY_CANARIES.oauthReason
      }),
      audit: (event) => productLogs.push(event)
    })
    const capabilities = broker.registerDeclarations([
      {
        kind: 'ssh-transport',
        referenceId: 'security-ssh',
        targetId: 'security-target',
        delivery: 'devbox-managed'
      },
      {
        kind: 'provider-auth',
        referenceId: 'security-github',
        provider: 'github',
        delivery: 'remote-enrollment'
      },
      {
        kind: 'mcp-oauth',
        referenceId: 'security-mcp',
        serverName: 'security-fixture',
        delivery: 'remote-bridge'
      }
    ])
    const forwardedCandidate = capabilities.find(({ class: kind }) => kind === 'forwarded-only')
    const machineCandidate = capabilities.find(({ class: kind }) => kind === 'machine-enrolled')
    const oauthCandidate = capabilities.find(({ class: kind }) => kind === 'oauth-per-host')
    if (
      !forwardedCandidate ||
      forwardedCandidate.class !== 'forwarded-only' ||
      !machineCandidate ||
      machineCandidate.class !== 'machine-enrolled' ||
      !oauthCandidate ||
      oauthCandidate.class !== 'oauth-per-host'
    ) {
      throw new Error('Security fixture capabilities were not registered.')
    }
    const forwarded = forwardedCandidate
    const machine = machineCandidate
    const oauth = oauthCandidate

    broker.updateForwardedConnection(forwarded.capabilityRef, {
      connectionRef: forwarded.connectionRef,
      connected: true,
      agentForwarding: true
    })
    const enrollment = await broker.enrollMachineCredential({
      capabilityRef: machine.capabilityRef,
      host: SECURITY_HOST_BINDING,
      targetPath: join(remoteRoot, 'credential', 'github-token'),
      secret: SECURITY_CANARIES.machineSecret,
      explicitEnrollment: true,
      providerHosts: [SECURITY_PROVIDER_HOST]
    })
    const issued = issueDevboxBridgeCapability(
      {
        kind: 'managed-phi-session',
        profileId: 'security-profile',
        targetId: 'security-target',
        sessionId: 'security-session',
        relayEpoch: 'security-epoch' as DevboxAuthorityEpoch,
        sshIdentity: SECURITY_HOST_IDENTITY
      },
      {
        capabilityId: 'security-capability',
        now: 1000
      }
    )
    expect(issued.ok).toBe(true)
    const oauthResult = await broker.authorizeOAuth({
      capabilityRef: oauth.capabilityRef,
      host: SECURITY_HOST_BINDING,
      hostRef: oauth.hostRef,
      bridgeCapability: issued.ok ? issued.capability : undefined
    })
    const doctor = new DevboxAuthDoctor({
      profileId: 'security-profile',
      targetId: 'security-target',
      capabilities: broker.capabilities(),
      probe: async ({ class: capabilityClass }) =>
        capabilityClass === 'forwarded-only'
          ? {
              reachability: 'reachable' as const,
              authorization: 'authorized' as const,
              reason: SECURITY_CANARIES.forwardedReason
            }
          : { reachability: 'reachable' as const, authorization: 'authorized' as const }
    })
    const doctorJson = await doctor.doctorJson()

    expect(enrollment.ok).toBe(true)
    expect(oauthResult.ok).toBe(false)
    expect(writes.map(({ stdin }) => stdin)).toContain(SECURITY_CANARIES.machineSecret)
    expect(writes.map(({ stdin }) => stdin)).toContain(SECURITY_CANARIES.generatedPrivateKey)
    expectNoCanary(productLogs)
    expectNoCanary(doctorJson)
    expectNoCanary(stringify({ enrollment, oauthResult, doctorJson }))

    const config = new DevboxConfigMaterializer({
      roots: {
        localRoot: '/fixture/local',
        remoteRoot: '/fixture/remote',
        localHome: '/fixture/local-home',
        remoteHome: '/fixture/remote-home'
      },
      overlay: {
        hostId: 'security-target',
        values: { '${DEVBOX_REMOTE_ROOT}': '/fixture/remote' }
      }
    })
    const normalized = config.normalize([
      {
        path: '/fixture/.pi/agent/secrets.env',
        format: 'shell',
        content: `UV_INDEX_URL=https://${SECURITY_CANARIES.machineSecret}.invalid`
      },
      {
        path: '/fixture/.pi/settings.json',
        format: 'json',
        content: '{"root":"/fixture/local","mode":"safe"}'
      }
    ])
    expect(normalized.intent).toBeDefined()
    const materialized = config.materialize(normalized.intent!)
    for (const document of materialized.rendered) {
      const path = join(fixtureRoot, 'materialized', document.path.replaceAll('/', '_'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, document.content, { mode: 0o600 })
    }
    expect(materialized.rendered.some(({ path }) => path.endsWith('secrets.env'))).toBe(false)
    expectNoCanary(materialized.rendered)
    expectNoCanary(
      materialized.rendered.map(({ path }) =>
        readFileSync(join(fixtureRoot, 'materialized', path.replaceAll('/', '_')), 'utf8')
      )
    )
    expect(config.parse(materialized.rendered, normalized.intent).sourcedPhiEnv).toBe(false)

    const journal = new DevboxOperationJournal({
      journalPath: join(fixtureRoot, 'journal.jsonl')
    })
    const journalContext = {
      profile: { id: 'security-profile', defaultAuthority: 'remote' } as DevboxProfileV1,
      deps: {}
    } as DevboxProvisionerContext
    journal.append(
      createProvisionOperation(journalContext, 'security-operation', 'provisioning', 100),
      { recordId: 'security-record' }
    )
    journal.checkpoint()

    const tracePath = join(fixtureRoot, 'trace.ndjson')
    writeFileSync(
      tracePath,
      `${JSON.stringify({
        endTimeUnixNano: String(Date.now() * 1_000_000),
        attributes: {
          brokerAudit: productLogs,
          directProviderError: `authorization: ${SECURITY_CANARIES.oauthReason}`
        }
      })}\n`,
      { mode: 0o600 }
    )
    const logs = new DevboxJobLogStore({ rootDir: join(fixtureRoot, 'workload') })
    const workloadPath = logs.pathFor('security-job')
    logs.append('security-job', SECURITY_CANARIES.workloadOutput)
    const workloadTail = logs.tail('security-job')
    const bundle = collectBundle({
      traceFilePath: tracePath,
      maxFiles: 2,
      daemonLogFilePath: workloadPath,
      daemonLogMaxFiles: 2,
      appVersion: 'security-fixture',
      platform: 'test',
      arch: 'test',
      osRelease: 'test',
      devboxChannel: 'dev'
    })

    expectNoCanary(bundle.payload)
    expectNoCanary(readFileSync(join(fixtureRoot, 'journal.jsonl'), 'utf8'))
    expectNoCanary(readFileSync(`${join(fixtureRoot, 'journal.jsonl')}.checkpoint`, 'utf8'))
    expectNoCanary(stringify([enrollment, oauthResult, doctorJson]))
    expect(workloadTail.text).toContain(SECURITY_CANARIES.workloadOutput)
    expect(workloadTail.includeInDiagnostics).toBe(false)
    expect(statSync(workloadPath).mode & 0o777).toBe(0o600)
    expect(bundle.payload).not.toContain(SECURITY_CANARIES.workloadOutput)
  })
})
