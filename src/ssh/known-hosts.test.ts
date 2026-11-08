import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  fingerprintSshSha256,
  matchKnownHosts,
  parseKnownHosts,
  parseSshPublicHostKey
} from './known-hosts'
import { formatKnownHostsHost, matchesKnownHostEntry } from './known-hosts-matching'

function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

describe('known-hosts', () => {
  it('uses the OpenSSH SHA256 base64 fingerprint without padding', () => {
    const key = Buffer.concat([sshString('ssh-ed25519'), sshString('host-key')])
    const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')

    expect(fingerprintSshSha256(key)).toBe(`SHA256:${expected}`)
    expect(parseSshPublicHostKey(key)).toMatchObject({
      type: 'ssh-ed25519',
      blob: key,
      fingerprint: `SHA256:${expected}`
    })
  })

  it('parses and matches direct, negated, and non-default-port entries', () => {
    const key = Buffer.concat([sshString('ssh-ed25519'), sshString('host-key')])
    const content = `[example.test]:2222 ssh-ed25519 ${key.toString('base64')} comment\n`
    const [entry] = parseKnownHosts(content, 'test-known-hosts')

    expect(entry).toMatchObject({
      patterns: ['[example.test]:2222'],
      keyType: 'ssh-ed25519',
      comment: 'comment',
      source: 'test-known-hosts'
    })
    expect(formatKnownHostsHost({ host: 'example.test', port: 2222 })).toBe(
      '[example.test]:2222'
    )
    expect(matchesKnownHostEntry(entry!, { host: 'example.test', port: 2222 })).toBe(true)
    expect(
      matchKnownHosts(entry ? [entry] : [], { host: 'example.test', port: 2222 }, parseSshPublicHostKey(key))
    ).toMatchObject({ status: 'trusted' })
    expect(matchesKnownHostEntry(entry!, { host: 'other.test', port: 2222 })).toBe(false)
  })
})
