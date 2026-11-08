import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertHubIsNotLocal } from '../cli/hub-local-guard'
import { profileSshEndpoint } from '../cli/profile-ssh'
import { buildProxyKeyscanArgv, scanSshKeysThroughProxy } from '../cli/ssh-proxy-keyscan'
import { isLocalSshEndpoint } from './local-endpoint'
import { buildSshPortForwardArgv } from './port-forward'
import { hasProxyCommandOption, knownHostsToken, normalizeDevboxProxyCommand, proxySshOptions } from './ssh-proxy'
import { buildSystemSshArgv } from './system-ssh-runner'

const PROXY = '/Users/u/.local/bin/devbox proxy'
const identity = { host: 'devbox', port: 22, username: 'alice', hostKeyFingerprint: 'SHA256:abc' }
const proxiedEndpoint = profileSshEndpoint({ sshTarget: { targetId: 't', identity, proxyCommand: PROXY } }, '/state/profiles/aws/known_hosts')

describe('ssh ProxyCommand options', () => {
  it('validates and trims the command, rejecting empty, NUL and newline values', () => {
    expect(normalizeDevboxProxyCommand(`  ${PROXY} `)).toBe(PROXY)
    for (const bad of ['', '  ', 'nc a 22\nid', 'nc a 22\r', 'nc\0']) {
      expect(() => normalizeDevboxProxyCommand(bad), JSON.stringify(bad)).toThrow('must be non-empty')
    }
  })

  it('pins HostKeyAlias to the known_hosts token so the pinned key verifies through the proxy', () => {
    expect(proxySshOptions('devbox', 22, PROXY)).toEqual([`ProxyCommand=${PROXY}`, 'HostKeyAlias=devbox'])
    expect(proxySshOptions('devbox', 2222, PROXY)).toEqual([`ProxyCommand=${PROXY}`, 'HostKeyAlias=[devbox]:2222'])
    expect(knownHostsToken('devbox', 2222)).toBe('[devbox]:2222')
    expect(proxySshOptions('devbox', 22, undefined)).toEqual([])
  })

  it('maps a profile to a system-ssh endpoint, unchanged when no proxy is set', () => {
    expect(proxiedEndpoint).toEqual({ host: 'devbox', port: 22, username: 'alice', knownHostsFile: '/state/profiles/aws/known_hosts', extraOptions: [`ProxyCommand=${PROXY}`, 'HostKeyAlias=devbox'] })
    expect(profileSshEndpoint({ sshTarget: { targetId: 't', identity } })).toEqual({ host: 'devbox', port: 22, username: 'alice' })
  })

  it('feeds command, script, shell-attach and login-relay ssh argv', () => {
    const plain = buildSystemSshArgv(proxiedEndpoint, 'bash -s')
    const relay = buildSystemSshArgv(proxiedEndpoint, 'exec tmux attach', undefined, { pty: true, remoteForwards: ['/tmp/relay.sock:127.0.0.1:5000'] })
    for (const args of [plain, relay]) {
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args).toContain('UserKnownHostsFile=/state/profiles/aws/known_hosts')
      expect(args).toContain(`ProxyCommand=${PROXY}`)
      expect(args).toContain('HostKeyAlias=devbox')
      expect(args.slice(args.indexOf('--'))[1]).toBe('alice@devbox')
    }
    expect(relay).toContain('-R')
    expect(() => buildSystemSshArgv({ ...proxiedEndpoint, extraOptions: ['ProxyCommand=a\nb'] }, 'true')).toThrow('newlines')
  })

  it('feeds port forwards', () => {
    const args = buildSshPortForwardArgv(proxiedEndpoint, 43210, '127.0.0.1', 8080)
    expect(args).toContain(`ProxyCommand=${PROXY}`)
    expect(args).toContain('HostKeyAlias=devbox')
    expect(args.at(-1)).toBe('alice@devbox')
  })

  it('never treats a proxied endpoint as this machine, and keeps the hub-is-local guard for real local hosts', () => {
    const probe = { username: 'alice', hostname: 'devbox', addresses: [] }
    expect(isLocalSshEndpoint({ host: 'devbox', port: 22, username: 'alice' }, probe)).toBe(true)
    expect(isLocalSshEndpoint(proxiedEndpoint, probe)).toBe(false)
    expect(hasProxyCommandOption(['proxycommand nc a 22'])).toBe(true)
    expect(hasProxyCommandOption(['LogLevel=ERROR'])).toBe(false)
    expect(() => assertHubIsNotLocal('devbox', { hostname: 'samples-MacBook-Pro', addresses: ['192.0.2.10'] })).not.toThrow()
    expect(() => assertHubIsNotLocal('localhost', { hostname: 'samples-MacBook-Pro', addresses: [] })).toThrow()
  })
})

describe('host-key scan through a ProxyCommand', () => {
  it('builds a no-auth probe that records the key under the alias in a scratch known_hosts', () => {
    const args = buildProxyKeyscanArgv({ host: 'devbox', port: 22, username: 'alice', proxyCommand: PROXY, knownHostsFile: '/tmp/kh', algorithm: 'ssh-ed25519' })
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null'])
    for (const option of [`ProxyCommand=${PROXY}`, 'HostKeyAlias=devbox', 'UserKnownHostsFile=/tmp/kh', 'StrictHostKeyChecking=accept-new', 'HashKnownHosts=no', 'HostKeyAlgorithms=ssh-ed25519', 'PubkeyAuthentication=no', 'PasswordAuthentication=no', 'BatchMode=yes']) {
      expect(args).toContain(option)
    }
    expect(args.slice(-3)).toEqual(['--', 'alice@devbox', 'true'])
  })

  it('collects one key per algorithm and ignores the expected auth failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-proxy-keyscan-test-'))
    try {
      const fake = join(root, 'ssh')
      const log = join(root, 'calls')
      writeFileSync(fake, `#!/bin/sh
kh=''; alg=''; alias=''
for a in "$@"; do case "$a" in UserKnownHostsFile=*) kh=\${a#*=};; HostKeyAlgorithms=*) alg=\${a#*=};; HostKeyAlias=*) alias=\${a#*=};; ProxyCommand=*) printf '%s\\n' "\${a#*=}" >> '${log}';; esac; done
case "$alg" in
  ssh-ed25519) printf '%s ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==\\n' "$alias" > "$kh" ;;
  rsa-sha2-512) printf '%s ssh-rsa AAAAB3NzaC1yc2EAAAAB\\n' "$alias" > "$kh" ;;
esac
echo 'alice@devbox: Permission denied (publickey).' >&2
exit 255
`)
      chmodSync(fake, 0o700)
      const keys = await scanSshKeysThroughProxy('devbox', 22, 'alice', PROXY, { sshBinary: fake })
      expect(keys.map((key) => key.line)).toEqual(['devbox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==\n', 'devbox ssh-rsa AAAAB3NzaC1yc2EAAAAB\n'])
      expect(keys.map((key) => key.type)).toEqual(['ssh-ed25519', 'ssh-rsa'])
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([PROXY, PROXY, PROXY])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails clearly when the proxy yields no host key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-proxy-keyscan-empty-'))
    try {
      const fake = join(root, 'ssh')
      writeFileSync(fake, '#!/bin/sh\nexit 255\n')
      chmodSync(fake, 0o700)
      await expect(scanSshKeysThroughProxy('devbox', 22, 'alice', PROXY, { sshBinary: fake })).rejects.toThrow('returned no keys')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
