import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DevboxMutagenSshConfig } from '../../sync/devbox-mutagen-ssh-config'
import { MutagenCli } from '../../sync/mutagen-cli'
import {
  approvedHostKey,
  boundedMonitorRunner,
  createBackendFixture,
  createProxyJump,
  identityFor
} from './backend-fixture'
import { transportFixtureReadiness, skipName } from './readiness'
import { startFixtureSshServer, type FixtureSshServer } from './ssh-server'

const readiness = transportFixtureReadiness()
const run = readiness.ready ? it : it.skip

const requestFor = (rootDirectory: string, profileId: string, suffix: string) => ({
  profileId,
  sessionId: `transport-${suffix}`,
  rootClassId: `fixture-${suffix}`,
  localRoot: join(rootDirectory, 'local', suffix),
  remoteRoot: 'workspace',
  mode: 'two-way-safe' as const
})

describe('Devbox real external transport', () => {
  run(skipName(readiness), async () => {
    if (!readiness.binaryPath) {
      throw new Error('transport fixture entered without a resolved Mutagen binary')
    }
    // macOS: unix-socket paths are capped at ~104 bytes and the default
    // $TMPDIR (/tmp/devbox-temp/...) pushes the Mutagen daemon socket past the
    // limit, so the daemon silently fails to start. Use a short root.
    const shortTmpRoot = process.platform === 'darwin' ? '/tmp' : tmpdir()
    const rootDirectory = mkdtempSync(join(shortTmpRoot, 'dvbx-transport-'))
    const servers: FixtureSshServer[] = []
    let direct: ReturnType<typeof createBackendFixture> | undefined
    let proxy: ReturnType<typeof createBackendFixture> | undefined
    try {
      const initialServer = await startFixtureSshServer(
        join(rootDirectory, 'initial-server'),
        readiness.binaryPath
      )
      servers.push(initialServer)
      const initialIdentity = identityFor(initialServer)
      const initialApproved = approvedHostKey(initialServer, initialIdentity)
      const initialConfig = new DevboxMutagenSshConfig({
        stateDirectory: join(rootDirectory, 'initial-state'),
        sshBinary: initialServer.sshBinaryPath,
        scpBinary: initialServer.scpBinaryPath
      })
      const initialMaterialRequest = {
        profileId: 'transport-initial',
        identity: initialIdentity,
        approvedHostKey: initialApproved
      }
      const initialMaterial = initialConfig.materialize(initialMaterialRequest)
      const knownHosts = readFileSync(initialMaterial.knownHostsPath, 'utf8')
      expect(knownHosts).toContain(initialServer.hostKey.publicKey)
      expect(knownHosts).toContain(initialServer.hostKey.fingerprint)
      const initialConfigText = readFileSync(initialMaterial.configPath, 'utf8')
      for (const option of [
        'StrictHostKeyChecking yes',
        'GlobalKnownHostsFile /dev/null',
        'ControlMaster no',
        'ControlPath none',
        'ForwardAgent no',
        'ForwardX11 no',
        'ClearAllForwardings yes'
      ]) {
        expect(initialConfigText).toContain(option)
      }

      const initialRequest = requestFor(rootDirectory, 'transport-initial', 'direct')
      direct = createBackendFixture(
        join(rootDirectory, 'initial-run'),
        readiness.binaryPath,
        initialMaterial,
        initialMaterialRequest,
        initialRequest
      )
      const identity = await direct.backend.create(initialRequest)
      expect(identity.sessionId).toBe(initialRequest.sessionId)
      expect(await direct.backend.listSessions()).toHaveLength(1)
      const parsed = await direct.cli.listSessions()
      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.labels['devbox-backend']).toBe('mutagen')
      await direct.backend.flush()
      await direct.backend.pause()
      expect((await direct.backend.status()).phase).toBe('paused')
      await direct.backend.resume()

      const monitorCli = new MutagenCli({
        binaryPath: readiness.binaryPath,
        appDataRoot: dirname(direct.cli.appPrivateDataDirectory),
        dataDirectory: direct.cli.appPrivateDataDirectory,
        profileId: initialRequest.profileId,
        commandRunner: boundedMonitorRunner,
        sshPath: initialMaterial.wrapperDirectory
      })
      await expect(monitorCli.monitor(identity.sessionId)).rejects.toMatchObject({
        code: 'operation_conflict',
        context: { field: 'malformed-monitor-output' }
      })
      await direct.backend.terminate(identity.sessionId)
      expect(await direct.cli.listSessions()).toHaveLength(0)

      const changedServer = await startFixtureSshServer(
        join(rootDirectory, 'changed-server'),
        readiness.binaryPath
      )
      servers.push(changedServer)
      const changedIdentity = identityFor(changedServer)
      const pinnedKnownHosts = readFileSync(initialMaterial.knownHostsPath, 'utf8')
      writeFileSync(
        initialMaterial.knownHostsPath,
        pinnedKnownHosts
          .replace(initialServer.hostKey.publicKey, changedServer.hostKey.publicKey)
          .replace(initialServer.hostKey.fingerprint, changedServer.hostKey.fingerprint)
      )
      await expect(direct.backend.create(initialRequest)).rejects.toMatchObject({
        code: 'unknown'
      })
      writeFileSync(initialMaterial.knownHostsPath, pinnedKnownHosts)
      const changedRequest = {
        ...initialMaterialRequest,
        profileId: 'transport-changed-alias',
        identity: changedIdentity,
        approvedHostKey: approvedHostKey(changedServer, changedIdentity)
      }
      expect(initialMaterial.isCurrent(changedRequest)).toBe(false)
      expect(changedIdentity.port).not.toBe(initialIdentity.port)
      expect(changedIdentity.hostKeyFingerprint).not.toBe(initialIdentity.hostKeyFingerprint)
      expect(() => DevboxMutagenSshConfig.assertCurrent(initialMaterial, changedRequest)).toThrow()
      const changedMaterial = initialConfig.materialize(changedRequest)
      expect(changedMaterial.alias).not.toBe(initialMaterial.alias)

      const hopServer = await startFixtureSshServer(
        join(rootDirectory, 'proxy-hop'),
        readiness.binaryPath
      )
      servers.push(hopServer)
      const proxyFixture = createProxyJump(
        changedServer,
        hopServer,
        'transport-proxy-jump',
        join(rootDirectory, 'proxy-state')
      )
      const proxyRequest = requestFor(rootDirectory, 'transport-proxy-jump', 'proxy')
      proxy = createBackendFixture(
        join(rootDirectory, 'proxy-run'),
        readiness.binaryPath,
        proxyFixture.material,
        proxyFixture.request,
        proxyRequest
      )
      const proxyIdentity = await proxy.backend.create(proxyRequest)
      expect(proxyIdentity.sessionId).toBe(proxyRequest.sessionId)
      expect(hopServer.forwardedConnections).toBeGreaterThan(0)
      await proxy.backend.flush()
      await proxy.backend.terminate(proxyIdentity.sessionId)
    } finally {
      for (const fixture of [proxy, direct]) {
        if (!fixture) {
          continue
        }
        for (const session of await fixture.cli.listSessions().catch(() => [])) {
          await fixture.cli.terminate(session.identifier).catch(() => undefined)
        }
        await fixture.cli.daemonStop().catch(() => undefined)
      }
      for (const server of servers.toReversed()) {
        await server.close().catch(() => undefined)
      }
      rmSync(rootDirectory, { recursive: true, force: true })
    }
  })
})
