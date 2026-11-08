import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DevboxMutagenSshConfig,
  type DevboxMutagenApprovedHostKey,
  type DevboxMutagenSshMaterialRequest
} from './devbox-mutagen-ssh-config'
import type { DevboxSshIdentity } from '../shared/devbox-types'

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

function rsaKeyMaterial(): Pick<
  DevboxMutagenApprovedHostKey,
  'algorithm' | 'publicKey' | 'fingerprint'
> {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as { e?: string; n?: string }
  if (!jwk.e || !jwk.n) {
    throw new Error('test RSA public key did not export as JWK')
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

const keyMaterial = rsaKeyMaterial()
const identity: DevboxSshIdentity = {
  host: 'devbox.example.test',
  port: 2222,
  username: 'sample',
  hostKeyFingerprint: keyMaterial.fingerprint
}

const approvedHostKey: DevboxMutagenApprovedHostKey = {
  endpoint: identity,
  ...keyMaterial
}

function request(
  overrides: Partial<DevboxMutagenSshMaterialRequest> = {}
): DevboxMutagenSshMaterialRequest {
  return {
    profileId: 'profile-1',
    identity,
    approvedHostKey,
    ...overrides
  }
}

function expectIdentityMismatch(action: () => unknown): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({
    code: 'ssh_identity_mismatch',
    context: { field: 'final-host-key-public-key-fingerprint' }
  })
}

describe('DevboxMutagenSshConfig', () => {
  it('accepts a real RSA key and writes strict app-private config', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-ssh-'))
    try {
      const material = new DevboxMutagenSshConfig({
        stateDirectory: resolve(root, 'state'),
        sshBinary: '/usr/bin/ssh',
        scpBinary: '/usr/bin/scp'
      }).materialize(request())
      const config = readFileSync(material.configPath, 'utf8')
      const knownHosts = readFileSync(material.knownHostsPath, 'utf8')
      expect(config).toContain('StrictHostKeyChecking yes')
      expect(config).toContain('ControlMaster no')
      expect(config).toContain('ForwardAgent no')
      expect(config).toContain('ForwardX11 no')
      expect(config).toContain('GlobalKnownHostsFile /dev/null')
      expect(knownHosts).toContain(identity.hostKeyFingerprint)
      expect(knownHosts).toContain('[devbox.example.test]:2222')
      expect(statSync(material.configPath).mode & 0o777).toBe(0o600)
      expect(statSync(material.knownHostsPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(material.wrapperDirectory, 'ssh')).mode & 0o777).toBe(0o700)
      expect(material.remoteEndpoint('/remote/project')).toBe(
        'sample@devbox-mutagen-profile-1:/remote/project'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a well-formed key whose bytes do not match the claimed fingerprint', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-ssh-mismatch-'))
    try {
      const attackerKey = rsaKeyMaterial()
      expect(attackerKey.fingerprint).not.toBe(approvedHostKey.fingerprint)
      const mismatched = { ...approvedHostKey, publicKey: attackerKey.publicKey }
      expect(mismatched.endpoint.hostKeyFingerprint).toBe(mismatched.fingerprint)
      expect(mismatched.fingerprint).toBe(identity.hostKeyFingerprint)
      expectIdentityMismatch(() =>
        new DevboxMutagenSshConfig({ stateDirectory: resolve(root, 'state') }).materialize(
          request({ approvedHostKey: mismatched })
        )
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['not-base64', 'not valid base64'],
    [sshField(Buffer.from('ssh-rsa')).toString('base64'), 'truncated blob'],
    [
      Buffer.concat([sshField(Buffer.from('ssh-ed25519')), sshField(Buffer.alloc(32))]).toString(
        'base64'
      ),
      'wrong algorithm identifier'
    ]
  ])('rejects malformed publicKey (%s)', (publicKey) => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-ssh-malformed-'))
    try {
      expectIdentityMismatch(() =>
        new DevboxMutagenSshConfig({ stateDirectory: resolve(root, 'state') }).materialize(
          request({ approvedHostKey: { ...approvedHostKey, publicKey } })
        )
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('invalidates material on endpoint or fingerprint changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-ssh-'))
    try {
      const material = new DevboxMutagenSshConfig({
        stateDirectory: resolve(root, 'state')
      }).materialize(request())
      expect(material.isCurrent(request())).toBe(true)
      expect(
        material.isCurrent(
          request({
            identity: { ...identity, port: 2223 },
            approvedHostKey: { ...approvedHostKey, endpoint: { ...identity, port: 2223 } }
          })
        )
      ).toBe(false)
      expect(
        material.isCurrent(
          request({
            identity: { ...identity, hostKeyFingerprint: 'SHA256:changed' },
            approvedHostKey: {
              ...approvedHostKey,
              endpoint: { ...identity, hostKeyFingerprint: 'SHA256:changed' },
              fingerprint: 'SHA256:changed'
            }
          })
        )
      ).toBe(false)
      expect(() =>
        DevboxMutagenSshConfig.assertCurrent(
          material,
          request({
            identity: { ...identity, hostKeyFingerprint: 'SHA256:changed' },
            approvedHostKey: {
              ...approvedHostKey,
              endpoint: { ...identity, hostKeyFingerprint: 'SHA256:changed' },
              fingerprint: 'SHA256:changed'
            }
          })
        )
      ).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires every ProxyJump endpoint to carry its matching approved key', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-proxy-'))
    try {
      const jumpKeyMaterial = rsaKeyMaterial()
      const jump: DevboxSshIdentity = {
        host: 'jump.example.test',
        port: 22,
        username: 'jump-user',
        hostKeyFingerprint: jumpKeyMaterial.fingerprint
      }
      const jumpKey: DevboxMutagenApprovedHostKey = {
        endpoint: jump,
        ...jumpKeyMaterial
      }
      const material = new DevboxMutagenSshConfig({
        stateDirectory: resolve(root, 'state')
      }).materialize(request({ proxyJump: [{ identity: jump, approvedHostKey: jumpKey }] }))
      const config = readFileSync(material.configPath, 'utf8')
      const knownHosts = readFileSync(material.knownHostsPath, 'utf8')
      expect(config).toContain(`ProxyJump ${material.alias}-jump-0`)
      expect(knownHosts).toContain(`jump.example.test ${jumpKeyMaterial.algorithm}`)
      expect(knownHosts).toContain(jump.hostKeyFingerprint)
      expect(() =>
        new DevboxMutagenSshConfig({ stateDirectory: resolve(root, 'other') }).materialize(
          request({
            proxyJump: [
              {
                identity: jump,
                approvedHostKey: { ...jumpKey, fingerprint: 'SHA256:not-jump-approved' }
              }
            ]
          })
        )
      ).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('routes the final host through a ProxyCommand with a pinned HostKeyAlias', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-proxy-command-'))
    try {
      const config = new DevboxMutagenSshConfig({ stateDirectory: resolve(root, 'state') })
      const proxied = request({ proxyCommand: ' /home/u/.local/bin/devbox proxy ' })
      const material = config.materialize(proxied)
      const text = readFileSync(material.configPath, 'utf8')
      expect(text).toContain('  ProxyCommand /home/u/.local/bin/devbox proxy\n')
      expect(text).toContain('  HostKeyAlias [devbox.example.test]:2222\n')
      expect(text).toContain('  StrictHostKeyChecking yes')
      expect(readFileSync(material.knownHostsPath, 'utf8')).toContain('[devbox.example.test]:2222 ssh-rsa')
      expect(material.isCurrent(proxied)).toBe(true)
      expect(material.isCurrent(request())).toBe(false)
      expect(readFileSync(config.materialize(request()).configPath, 'utf8')).not.toContain('ProxyCommand')
      for (const proxyCommand of ['', 'nc a 22\nrm -rf /']) {
        expect(() => config.materialize(request({ proxyCommand }))).toThrow()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
