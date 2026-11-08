import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SshHostEndpoint, SshKnownHostEntry } from './known-hosts'

export function decodeKnownHostKey(encoded: string): Buffer | null {
  try {
    return decodeBase64Strict(encoded)
  } catch {
    return null
  }
}

export function matchesKnownHostEntry(
  entry: Pick<SshKnownHostEntry, 'patterns'>,
  endpoint: SshHostEndpoint
): boolean {
  let positiveMatch = false
  for (const rawPattern of entry.patterns) {
    if (!rawPattern) {
      continue
    }
    const negated = rawPattern.startsWith('!')
    const pattern = negated ? rawPattern.slice(1) : rawPattern
    if (!pattern || !matchesHostPattern(pattern, endpoint)) {
      continue
    }
    if (negated) {
      return false
    }
    positiveMatch = true
  }
  return positiveMatch
}

export function formatKnownHostsHost(endpoint: SshHostEndpoint): string {
  const host = stripHostBrackets(endpoint.host.trim())
  if (endpoint.port === 22 && !host.includes(':')) {
    return host
  }
  return `[${host}]:${endpoint.port}`
}

function matchesHostPattern(pattern: string, endpoint: SshHostEndpoint): boolean {
  if (pattern.startsWith('|1|')) {
    return matchesHashedHost(pattern, endpoint)
  }
  return getKnownHostCandidates(endpoint).some((candidate) => globMatches(pattern, candidate))
}

function getKnownHostCandidates(endpoint: SshHostEndpoint): string[] {
  const rawHost = stripHostBrackets(endpoint.host.trim())
  const host = rawHost.toLowerCase()
  const endpointToken = formatKnownHostsHost({ ...endpoint, host }).toLowerCase()
  const rawEndpointToken = formatKnownHostsHost({ ...endpoint, host: rawHost })
  const candidates = [host, rawHost, endpointToken, rawEndpointToken]
  if (endpoint.port === 22) {
    candidates.push(`[${host}]:22`)
  }
  return [...new Set(candidates)]
}

function matchesHashedHost(pattern: string, endpoint: SshHostEndpoint): boolean {
  const parts = pattern.split('|')
  if (parts.length !== 4 || parts[1] !== '1') {
    return false
  }
  let salt: Buffer
  let expected: Buffer
  try {
    salt = decodeBase64Strict(parts[2])
    expected = decodeBase64Strict(parts[3])
  } catch {
    return false
  }
  return getKnownHostCandidates(endpoint).some((candidate) => {
    const actual = createHmac('sha1', salt).update(candidate).digest()
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

function globMatches(pattern: string, value: string): boolean {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\' && index + 1 < pattern.length) {
      index += 1
      expression += escapeRegex(pattern[index])
    } else if (character === '*') {
      expression += '.*'
    } else if (character === '?') {
      expression += '.'
    } else {
      expression += escapeRegex(character)
    }
  }
  try {
    return new RegExp(`${expression}$`, 'iu').test(value)
  } catch {
    return false
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function decodeBase64Strict(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64')
  }
  const decoded = Buffer.from(value, 'base64')
  if (value.replace(/=+$/u, '') !== decoded.toString('base64').replace(/=+$/u, '')) {
    throw new Error('Invalid base64')
  }
  return decoded
}

export function extractCertificateAuthorityKey(blob: Buffer, type: string): Buffer | undefined {
  if (!type.endsWith('-cert-v01@openssh.com')) {
    return undefined
  }
  let offset = 0
  const first = readSshString(blob, offset)
  if (!first) {
    return undefined
  }
  offset = first.nextOffset
  const nonce = readSshString(blob, offset)
  if (!nonce) {
    return undefined
  }
  offset = nonce.nextOffset
  const fieldsToSkip = type.startsWith('ssh-rsa-')
    ? 2
    : type.startsWith('ssh-dss-')
      ? 4
      : type.startsWith('ecdsa-') || type.startsWith('sk-ecdsa-sha2-')
        ? 2
        : type.startsWith('ssh-ed25519-') || type.startsWith('sk-ssh-ed25519-')
          ? 1
          : 0
  for (let index = 0; index < fieldsToSkip; index += 1) {
    const field = readSshString(blob, offset)
    if (!field) {
      return undefined
    }
    offset = field.nextOffset
  }
  if (offset + 12 > blob.length) {
    return undefined
  }
  offset += 12
  for (let index = 0; index < 2; index += 1) {
    const field = readSshString(blob, offset)
    if (!field) {
      return undefined
    }
    offset = field.nextOffset
  }
  if (offset + 16 > blob.length) {
    return undefined
  }
  offset += 16
  for (let index = 0; index < 3; index += 1) {
    const field = readSshString(blob, offset)
    if (!field) {
      return undefined
    }
    offset = field.nextOffset
  }
  return readSshString(blob, offset)?.bytes
}

function readSshString(
  value: Buffer,
  offset: number
): { value: string; bytes: Buffer; nextOffset: number } | null {
  if (offset < 0 || offset + 4 > value.length) {
    return null
  }
  const length = value.readUInt32BE(offset)
  const start = offset + 4
  const end = start + length
  if (end > value.length) {
    return null
  }
  return {
    value: value.subarray(start, end).toString('utf8'),
    bytes: value.subarray(start, end),
    nextOffset: end
  }
}

function stripHostBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}
