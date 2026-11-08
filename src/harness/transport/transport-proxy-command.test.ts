import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { scanSshKeysThroughProxy } from '../../cli/ssh-proxy-keyscan'
import { fingerprintSshSha256 } from '../../ssh/known-hosts'
import { proxySshOptions } from '../../ssh/ssh-proxy'
import { createSystemSshRunner } from '../../ssh/system-ssh-runner'
import { DevboxMutagenSshConfig } from '../../sync/devbox-mutagen-ssh-config'
import { approvedHostKey, createBackendFixture, identityFor } from './backend-fixture'
import { transportFixtureReadiness, skipName } from './readiness'
import { startFixtureSshServer, type FixtureSshServer } from './ssh-server'

const readiness = transportFixtureReadiness()
const run = readiness.ready ? it : it.skip
// An alias that DNS can never resolve: every byte must flow through the ProxyCommand.
const ALIAS = 'devbox-proxy-fixture.invalid'

function tcpProxyCommand(rootDirectory: string, port: number): string {
  const script = join(rootDirectory, 'tcp-proxy.mjs')
  writeFileSync(script, [
    "import { connect } from 'node:net'",
    'const socket = connect(Number(process.argv[3]), process.argv[2])',
    'process.stdin.pipe(socket); socket.pipe(process.stdout)',
    "socket.on('close', () => process.exit(0)); socket.on('error', () => process.exit(1))",
    ''
  ].join('\n'))
  return `'${process.execPath}' '${script}' 127.0.0.1 ${port}`
}

describe('Devbox real transport through a ProxyCommand', () => {
  run(skipName(readiness), async () => {
    if (!readiness.binaryPath) {
      throw new Error('transport fixture entered without a resolved Mutagen binary')
    }
    const shortTmpRoot = process.platform === 'darwin' ? '/tmp' : tmpdir()
    const rootDirectory = mkdtempSync(join(shortTmpRoot, 'dvbx-proxycmd-'))
    let server: FixtureSshServer | undefined
    let fixture: ReturnType<typeof createBackendFixture> | undefined
    try {
      server = await startFixtureSshServer(join(rootDirectory, 'server'), readiness.binaryPath)
      const proxyCommand = tcpProxyCommand(rootDirectory, server.port)
      const identity = { ...identityFor(server), host: ALIAS }

      // Host-key step: real OpenSSH reads the key through the proxy (ssh-keyscan cannot).
      const keys = await scanSshKeysThroughProxy(ALIAS, identity.port, identity.username, proxyCommand, { sshBinary: server.sshBinaryPath, firstTimeoutMs: 30_000, timeoutMs: 15_000 })
      expect(keys.map((key) => fingerprintSshSha256(key.blob))).toContain(server.hostKey.fingerprint)
      expect(keys.every((key) => key.line.startsWith(`[${ALIAS}]:${identity.port} `))).toBe(true)

      // System ssh runner: StrictHostKeyChecking=yes verifies the pinned key via HostKeyAlias.
      const knownHostsFile = join(rootDirectory, 'known_hosts')
      writeFileSync(knownHostsFile, keys.map((key) => key.line).join(''), { mode: 0o600 })
      const endpoint = { host: ALIAS, port: identity.port, username: identity.username, knownHostsFile, extraOptions: proxySshOptions(ALIAS, identity.port, proxyCommand) }
      // The fixture server only emulates enough of a shell for the Mutagen agent, so
      // assert on the authenticated, key-verified session OpenSSH reports at DEBUG1.
      const ssh = createSystemSshRunner({ ...endpoint, extraOptions: [...endpoint.extraOptions, 'LogLevel=DEBUG1'] }, { sshBinary: server.sshBinaryPath })
      const outcome = (): Promise<string> => ssh.command('true', 15_000).then(() => 'Authenticated to (via proxy) ok', (error: Error) => error.message)
      const verified = await outcome()
      expect(verified).toMatch(/Authenticated to .*\(via proxy\)/u)
      expect(verified).not.toContain('Host key verification failed')
      writeFileSync(knownHostsFile, keys.map((key) => key.line.replace(`[${ALIAS}]`, '[other-alias]')).join(''))
      expect(await outcome()).toContain('Host key verification failed')

      // Mutagen: the generated Host block carries ProxyCommand + HostKeyAlias.
      const materialRequest = { profileId: 'transport-proxy-command', identity, approvedHostKey: approvedHostKey(server, identity), proxyCommand }
      const material = new DevboxMutagenSshConfig({ stateDirectory: join(rootDirectory, 'state'), sshBinary: server.sshBinaryPath, scpBinary: server.scpBinaryPath }).materialize(materialRequest)
      expect(readFileSync(material.configPath, 'utf8')).toContain(`ProxyCommand ${proxyCommand}`)
      const request = { profileId: materialRequest.profileId, sessionId: 'transport-proxy-command', rootClassId: 'fixture-proxy-command', localRoot: join(rootDirectory, 'local'), remoteRoot: 'workspace', mode: 'two-way-safe' as const }
      fixture = createBackendFixture(join(rootDirectory, 'run'), readiness.binaryPath, material, materialRequest, request)
      const session = await fixture.backend.create(request)
      expect(session.sessionId).toBe(request.sessionId)
      await fixture.backend.flush()
      expect(readFileSync(join(server.homeDirectory, 'workspace', 'transport-sentinel.txt'), 'utf8')).toBe('fixture-sentinel\n')
      await fixture.backend.terminate(session.sessionId)
    } finally {
      if (fixture) {
        for (const session of await fixture.cli.listSessions().catch(() => [])) {
          await fixture.cli.terminate(session.identifier).catch(() => undefined)
        }
        await fixture.cli.daemonStop().catch(() => undefined)
      }
      await server?.close().catch(() => undefined)
      rmSync(rootDirectory, { recursive: true, force: true })
    }
  })
})
