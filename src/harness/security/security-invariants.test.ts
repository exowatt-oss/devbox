import { createHash, generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DevboxConfigMaterializer } from '../../core/devbox-config-materializer'
import {
  authorizeProvision,
  type DevboxProvisionerContext
} from '../../core/devbox-provisioner-operations'
import { DevboxMutagenSshConfig } from '../../sync/devbox-mutagen-ssh-config'
import {
  MutagenCli,
  type MutagenCommandRunner,
  type MutagenSessionRecord
} from '../../sync/mutagen-cli'
import type { DevboxSshIdentity } from '../../shared/devbox-types'

function sshField(value: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(value.length)
  return Buffer.concat([length, value])
}

function sshMpint(value: Buffer): Buffer {
  let normalized = value
  while (normalized.length > 1 && normalized[0] === 0) {
    normalized = normalized.subarray(1)
  }
  if (normalized[0] !== undefined && (normalized[0] & 0x80) !== 0) {
    normalized = Buffer.concat([Buffer.from([0]), normalized])
  }
  return sshField(normalized)
}

function rsaHostKeyMaterial(): {
  algorithm: string
  publicKey: string
  fingerprint: string
} {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as { e?: string; n?: string }
  if (!jwk.e || !jwk.n) {
    throw new Error('security fixture RSA public key did not export as JWK')
  }
  const blob = Buffer.concat([
    sshField(Buffer.from('ssh-rsa')),
    sshMpint(Buffer.from(jwk.e, 'base64url')),
    sshMpint(Buffer.from(jwk.n, 'base64url'))
  ])
  return {
    algorithm: 'ssh-rsa',
    publicKey: blob.toString('base64'),
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
  }
}

const keyMaterial = rsaHostKeyMaterial()
const identity: DevboxSshIdentity = {
  host: 'devbox.security.test',
  port: 2222,
  username: 'fixture-user',
  hostKeyFingerprint: keyMaterial.fingerprint
}

const approvedHostKey = {
  endpoint: identity,
  ...keyMaterial
}

const session: MutagenSessionRecord = {
  identifier: 'security-session-id',
  name: 'security-session',
  labels: {
    'devbox-profile': 'security-profile',
    'devbox-session': 'security-session',
    'devbox-root-class': 'working',
    'devbox-backend': 'mutagen'
  },
  paused: false,
  status: 'watching',
  successfulCycles: 1,
  conflicts: [],
  watch: { mode: 'portable', pollingInterval: 10, native: true },
  lastChangeAt: null,
  lastSynchronizedAt: null
}

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

function sourceLine(relativePath: string, anchor: string): number {
  const content = source(relativePath)
  const index = content.indexOf(anchor)
  expect(index, `${relativePath} must retain ${anchor}`).toBeGreaterThanOrEqual(0)
  return content.slice(0, index).split('\n').length
}

describe('Devbox release invariants', () => {
  it('scopes global configuration opt-out to create and isolates data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-security-'))
    try {
      const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
      const runner: MutagenCommandRunner = async (_command, args, options) => {
        calls.push({ args, env: options.env })
        if (args[0] === 'sync' && args[1] === 'list') {
          return { exitCode: 0, stdout: JSON.stringify([session]), stderr: '' }
        }
        if (args[0] === 'sync' && args[1] === 'monitor') {
          return { exitCode: 0, stdout: `${JSON.stringify([session])}\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      const dataDirectory = resolve(root, 'app-data', 'mutagen')
      const cli = new MutagenCli({
        binaryPath: resolve(root, 'bin', 'mutagen'),
        appDataRoot: resolve(root, 'app-data'),
        dataDirectory,
        profileId: 'security-profile',
        commandRunner: runner
      })
      const request = {
        profileId: 'security-profile',
        sessionId: 'security-session',
        rootClassId: 'working',
        localRoot: '/fixture/local',
        remoteRoot: '/fixture/remote',
        mode: 'two-way-safe' as const
      }
      await cli.createSession(request, {
        remoteEndpoint: 'fixture-user@devbox-mutagen-security:/fixture/remote',
        name: 'security-session',
        labels: session.labels
      })
      await cli.listSessions()
      await cli.monitor(session.identifier)
      await cli.pause(session.identifier)
      await cli.resume(session.identifier)
      await cli.flush(session.identifier)
      await cli.terminate(session.identifier)
      await cli.daemonStart()
      await cli.daemonStop()

      expect(calls.length).toBeGreaterThan(0)
      // v0.18.1 registers the global-configuration opt-out on create only; every command still
      // uses the app-private data directory to avoid inheriting ambient Mutagen state.
      for (const call of calls) {
        if (call.args.includes('create')) {
          expect(call.args).toContain('--no-global-configuration')
        } else {
          expect(call.args).not.toContain('--no-global-configuration')
        }
        expect(call.env.MUTAGEN_DATA_DIRECTORY).toBe(dataDirectory)
        expect(call.env.MUTAGEN_DATA_DIRECTORY).not.toContain('.mutagen')
      }
      await expect(cli.terminate('--all')).rejects.toMatchObject({
        code: 'operation_conflict'
      })
      expect(calls.flatMap(({ args }) => args)).not.toContain('--all')
      expect(sourceLine('../../sync/mutagen-cli.ts', 'MUTAGEN_DATA_DIRECTORY')).toBeGreaterThan(0)
      expect(
        sourceLine('../../sync/mutagen-cli-argv.ts', "'--no-global-configuration'")
      ).toBeGreaterThan(0)
      expect(sourceLine('../../sync/mutagen-cli.ts', "sessionId.startsWith('-')")).toBeGreaterThan(
        0
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits strict non-forwarding SSH configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-ssh-security-'))
    try {
      const material = new DevboxMutagenSshConfig({
        stateDirectory: resolve(root, 'state')
      }).materialize({
        profileId: 'security-profile',
        identity,
        approvedHostKey
      })
      const config = readFileSync(material.configPath, 'utf8')
      expect(config).toContain('StrictHostKeyChecking yes')
      expect(config).toContain('ControlMaster no')
      expect(config).toContain('ForwardAgent no')
      expect(config).toContain('ClearAllForwardings yes')
      expect(
        sourceLine('../../sync/devbox-mutagen-ssh-config.ts', "'  ClearAllForwardings yes'")
      ).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('materializes secrets.env as excluded data and never sources it', () => {
    const canary = 'synthetic-phi-env-value-7f2a'
    const materializer = new DevboxConfigMaterializer({
      roots: { localRoot: '/fixture/local', remoteRoot: '/fixture/remote' },
      overlay: { hostId: 'security-profile', values: {} }
    })
    const normalized = materializer.normalize([
      {
        path: '/fixture/.pi/agent/secrets.env',
        format: 'shell',
        content: `UV_INDEX_URL=https://${canary}.invalid`
      },
      {
        path: '/fixture/.pi/settings.json',
        format: 'json',
        content: '{"mode":"safe"}'
      }
    ])
    expect(normalized.intent).toBeDefined()
    const rendered = materializer.materialize(normalized.intent!).rendered
    expect(rendered.every(({ path }) => !path.endsWith('secrets.env'))).toBe(true)
    expect(materializer.parse(rendered).sourcedPhiEnv).toBe(false)
    expect(source('../../core/devbox-config-materializer.ts')).not.toMatch(
      /(?:^|[^a-z])(?:source|\.)\s+[^\n]*secrets\.env/m
    )
    expect(
      sourceLine('../../core/devbox-config-materializer.ts', 'sourcedPhiEnv: false')
    ).toBeGreaterThan(0)
  })

  it.skip('real Mutagen/OpenSSH/ProxyJump transport requires a Mutagen binary and a real OpenSSH host', () =>
    undefined)

  it('delivers the sudo secret through stdin and zeroes the buffer', async () => {
    const captured: Uint8Array[] = []
    const context = {
      profile: { id: 'security-profile', sshTarget: { identity } },
      deps: {
        remoteExec: async (request: {
          command: string
          args: readonly string[]
          stdin?: Uint8Array
        }) => {
          if (request.command === 'sudo' && request.args[0] === '-n') {
            return { exitCode: 1, stdout: '', stderr: '' }
          }
          if (request.command === 'sudo' && request.args[0] === '-S') {
            captured.push(request.stdin!)
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
        secureSudoPrompt: async () => 'synthetic-sudo-secret-7f2a'
      }
    } as unknown as DevboxProvisionerContext

    await authorizeProvision(context, 'security-operation', {}, {})
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual(new Uint8Array(captured[0]!.length))
    expect(sourceLine('../../core/devbox-provisioner-operations.ts', 'input.fill(0)')).toBeGreaterThan(0)
    expect(source('../../core/devbox-provisioner-operations.ts')).toContain("args: ['-S', '-v']")
  })
})
