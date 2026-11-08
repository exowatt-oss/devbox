import { chmodSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { writeSecureFile } from '../ssh/secure-file'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxSshIdentity } from '../shared/devbox-types'
import { matchesDevboxMutagenSshFingerprint } from './devbox-mutagen-fingerprint'
import { isValidDevboxProxyCommand } from '../ssh/ssh-proxy'

export type DevboxMutagenApprovedHostKey = {
  endpoint: DevboxSshIdentity
  algorithm: string
  publicKey: string
  fingerprint: string
}

export type DevboxMutagenProxyJump = {
  identity: DevboxSshIdentity
  approvedHostKey: DevboxMutagenApprovedHostKey
}

export type DevboxMutagenSshMaterialRequest = {
  profileId: string
  identity: DevboxSshIdentity
  approvedHostKey: DevboxMutagenApprovedHostKey
  proxyJump?: readonly DevboxMutagenProxyJump[]
  /** OpenSSH ProxyCommand for the final host; mutually exclusive with proxyJump. */
  proxyCommand?: string
}

export type DevboxMutagenSshConfigOptions = {
  stateDirectory: string
  sshBinary?: string
  scpBinary?: string
}

export type DevboxMutagenSshConfigMaterial = {
  profileId: string
  alias: string
  configPath: string
  knownHostsPath: string
  wrapperDirectory: string
  endpoint: DevboxSshIdentity
  proxyJump: readonly DevboxMutagenProxyJump[]
  isCurrent(request: DevboxMutagenSshMaterialRequest): boolean
  remoteEndpoint(remoteRoot: string): string
}

const identityMismatch = (field: string): DevboxError =>
  createDevboxError('ssh_identity_mismatch', { context: { field } })

function identityKey(identity: DevboxSshIdentity): string {
  return JSON.stringify([
    identity.host,
    identity.port,
    identity.username,
    identity.hostKeyFingerprint
  ])
}

function endpointKey(identity: DevboxSshIdentity): string {
  return JSON.stringify([identity.host, identity.port, identity.username])
}

function hostToken(identity: DevboxSshIdentity): string {
  return identity.port === 22 ? identity.host : `[${identity.host}]:${identity.port}`
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

function safeName(value: string): string {
  const result = value.replace(/[^A-Za-z0-9._-]/gu, '-')
  if (!result || result === '.' || result === '..') {
    throw identityMismatch('profile-id')
  }
  return result
}

function assertIdentity(identity: DevboxSshIdentity, field: string): void {
  if (
    !identity.host ||
    /\s/u.test(identity.host) ||
    identity.host.startsWith('-') ||
    !Number.isInteger(identity.port) ||
    identity.port < 1 ||
    identity.port > 65535 ||
    !identity.username ||
    /\s/u.test(identity.username) ||
    identity.username.startsWith('-') ||
    !identity.hostKeyFingerprint ||
    /[\r\n]/u.test(identity.hostKeyFingerprint)
  ) {
    throw identityMismatch(field)
  }
}

function assertApprovedKey(
  expected: DevboxSshIdentity,
  approved: DevboxMutagenApprovedHostKey,
  field: string
): void {
  assertIdentity(expected, field)
  assertIdentity(approved.endpoint, `${field}-endpoint`)
  if (
    endpointKey(approved.endpoint) !== endpointKey(expected) ||
    approved.endpoint.hostKeyFingerprint !== approved.fingerprint ||
    approved.fingerprint !== expected.hostKeyFingerprint ||
    approved.fingerprint.length === 0 ||
    !approved.algorithm ||
    !/^[A-Za-z0-9@._+-]+$/u.test(approved.algorithm) ||
    !approved.publicKey ||
    /\s/u.test(approved.publicKey)
  ) {
    throw identityMismatch(`${field}-fingerprint-or-endpoint`)
  }
  if (
    !matchesDevboxMutagenSshFingerprint(
      approved.algorithm,
      approved.publicKey,
      approved.fingerprint
    )
  ) {
    throw identityMismatch(`${field}-public-key-fingerprint`)
  }
}

function renderHostBlock(
  alias: string,
  identity: DevboxSshIdentity,
  knownHostsPath: string,
  proxyJump?: string,
  proxyCommand?: string
): string {
  return [
    `Host ${alias}`,
    `  HostName ${identity.host}`,
    `  Port ${identity.port}`,
    `  User ${identity.username}`,
    `  UserKnownHostsFile ${knownHostsPath}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes',
    '  ControlMaster no',
    '  ControlPath none',
    '  ControlPersist no',
    '  ForwardAgent no',
    '  ForwardX11 no',
    '  ForwardX11Trusted no',
    '  ClearAllForwardings yes',
    '  RequestTTY no',
    ...(proxyJump ? [`  ProxyJump ${proxyJump}`] : []),
    // The known_hosts line is written under hostToken(identity); pin the alias so
    // StrictHostKeyChecking verifies the approved key through the proxy.
    ...(proxyCommand ? [`  ProxyCommand ${proxyCommand}`, `  HostKeyAlias ${hostToken(identity)}`] : []),
    ''
  ].join('\n')
}

function renderKnownHostLine(approved: DevboxMutagenApprovedHostKey): string {
  return `${hostToken(approved.endpoint)} ${approved.algorithm} ${approved.publicKey} devbox-approved ${approved.fingerprint}`
}

function renderWrapper(binary: string, configPath: string, knownHostsPath: string): string {
  const options = [
    `-F ${shellQuote(configPath)}`,
    `-o UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    '-o GlobalKnownHostsFile=/dev/null',
    '-o StrictHostKeyChecking=yes',
    '-o ControlMaster=no',
    '-o ControlPath=none',
    '-o ForwardAgent=no',
    '-o ForwardX11=no',
    '-o ClearAllForwardings=yes'
  ].join(' ')
  return ['#!/bin/sh', 'set -eu', `exec ${shellQuote(binary)} ${options} "$@"`, ''].join('\n')
}

function sameRequest(
  left: DevboxMutagenSshMaterialRequest,
  right: DevboxMutagenSshMaterialRequest
): boolean {
  return (
    left.profileId === right.profileId &&
    identityKey(left.identity) === identityKey(right.identity) &&
    left.approvedHostKey.fingerprint === right.approvedHostKey.fingerprint &&
    (left.proxyCommand ?? null) === (right.proxyCommand ?? null) &&
    (left.proxyJump ?? []).length === (right.proxyJump ?? []).length &&
    (left.proxyJump ?? []).every(
      (hop, index) =>
        identityKey(hop.identity) ===
          identityKey(right.proxyJump?.[index]?.identity as DevboxSshIdentity) &&
        hop.approvedHostKey.fingerprint === right.proxyJump?.[index]?.approvedHostKey.fingerprint
    )
  )
}

export class DevboxMutagenSshConfig {
  private readonly stateDirectory: string
  private readonly sshBinary: string
  private readonly scpBinary: string

  constructor(options: DevboxMutagenSshConfigOptions) {
    if (
      !isAbsolute(options.stateDirectory) ||
      resolve(options.stateDirectory) !== options.stateDirectory
    ) {
      throw identityMismatch('state-directory')
    }
    this.stateDirectory = options.stateDirectory
    this.sshBinary = options.sshBinary ?? '/usr/bin/ssh'
    this.scpBinary = options.scpBinary ?? '/usr/bin/scp'
    if (!isAbsolute(this.sshBinary) || !isAbsolute(this.scpBinary)) {
      throw identityMismatch('ssh-binary')
    }
  }

  materialize(request: DevboxMutagenSshMaterialRequest): DevboxMutagenSshConfigMaterial {
    const profileName = safeName(request.profileId)
    assertApprovedKey(request.identity, request.approvedHostKey, 'final-host-key')
    const proxyJump = [...(request.proxyJump ?? [])]
    if (request.proxyCommand !== undefined && (!isValidDevboxProxyCommand(request.proxyCommand) || proxyJump.length > 0)) {
      throw identityMismatch('proxy-command')
    }
    const endpointKeys = new Set([endpointKey(request.identity)])
    const approvedKeys = [request.approvedHostKey]
    for (const [index, hop] of proxyJump.entries()) {
      assertApprovedKey(hop.identity, hop.approvedHostKey, `proxy-jump-${index}`)
      if (endpointKeys.has(endpointKey(hop.identity))) {
        throw identityMismatch('proxy-jump-duplicate-endpoint')
      }
      endpointKeys.add(endpointKey(hop.identity))
      approvedKeys.push(hop.approvedHostKey)
    }

    const alias = `devbox-mutagen-${profileName}`
    const configPath = join(this.stateDirectory, 'ssh', `${profileName}.config`)
    const knownHostsPath = join(this.stateDirectory, 'ssh', `${profileName}.known_hosts`)
    const wrapperDirectory = join(this.stateDirectory, 'ssh', `${profileName}-bin`)
    const proxyAliases = proxyJump.map((_, index) => `${alias}-jump-${index}`)
    const config = [
      ...proxyJump.map((hop, index) =>
        renderHostBlock(proxyAliases[index], hop.identity, knownHostsPath, proxyAliases[index + 1])
      ),
      renderHostBlock(alias, request.identity, knownHostsPath, proxyAliases[0], request.proxyCommand?.trim()),
      '# Devbox owns this config; it is not merged with the user SSH config.',
      ''
    ].join('\n')
    const knownHosts = `${approvedKeys.map(renderKnownHostLine).join('\n')}\n`
    writeSecureFile(configPath, config)
    writeSecureFile(knownHostsPath, knownHosts)
    writeSecureFile(
      join(wrapperDirectory, 'ssh'),
      renderWrapper(this.sshBinary, configPath, knownHostsPath)
    )
    writeSecureFile(
      join(wrapperDirectory, 'scp'),
      renderWrapper(this.scpBinary, configPath, knownHostsPath)
    )
    chmodSync(join(wrapperDirectory, 'ssh'), 0o700)
    chmodSync(join(wrapperDirectory, 'scp'), 0o700)

    return {
      profileId: request.profileId,
      alias,
      configPath,
      knownHostsPath,
      wrapperDirectory,
      endpoint: request.identity,
      proxyJump: Object.freeze(proxyJump),
      isCurrent: (current) => sameRequest(request, current),
      remoteEndpoint: (remoteRoot) => {
        if (!remoteRoot || remoteRoot.startsWith('-')) {
          throw identityMismatch('remote-root')
        }
        return `${request.identity.username}@${alias}:${remoteRoot}`
      }
    }
  }

  static assertCurrent(
    material: DevboxMutagenSshConfigMaterial,
    request: DevboxMutagenSshMaterialRequest
  ): void {
    if (!material.isCurrent(request)) {
      throw identityMismatch('endpoint-or-host-key')
    }
  }
}
