import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeSecureFile } from './secure-file'
import {
  decodeKnownHostKey,
  extractCertificateAuthorityKey,
  formatKnownHostsHost,
  matchesKnownHostEntry
} from './known-hosts-matching'

export { formatKnownHostsHost, matchesKnownHostEntry } from './known-hosts-matching'
export type SshKnownHostMarker = 'direct' | 'revoked' | 'cert-authority'
export type SshKnownHostEntry = {
  marker: SshKnownHostMarker
  patterns: string[]
  keyType: string
  key: Buffer
  comment?: string
  source?: string
}
export type SshHostEndpoint = {
  host: string
  port: number
}
export type SshPublicHostKey = {
  type: string
  blob: Buffer
  fingerprint: string
  certificateAuthorityKey?: Buffer
}
export type SshKnownHostsMatch =
  | { status: 'trusted'; entry: SshKnownHostEntry }
  | { status: 'revoked'; entry: SshKnownHostEntry }
  | { status: 'changed'; entries: SshKnownHostEntry[] }
  | { status: 'unknown' }
const SHA256_FINGERPRINT_PREFIX = 'SHA256:'
const DEFAULT_APP_KNOWN_HOSTS_RELATIVE_PATH = join('ssh', 'known_hosts')
export function parseSshPublicHostKey(
  key: Buffer | { type: string; blob: Buffer }
): SshPublicHostKey {
  const blob = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(key.blob)
  const firstField = readSshString(blob, 0)
  const type = Buffer.isBuffer(key) ? firstField?.value : key.type
  if (!type || !/^[\x20-\x7e]+$/u.test(type) || firstField?.value !== type) {
    throw new Error('SSH host key does not contain a valid algorithm name')
  }
  if (firstField.nextOffset >= blob.length) {
    throw new Error('SSH host key is not a complete public-key blob')
  }
  return {
    type,
    blob,
    fingerprint: fingerprintSshSha256(blob),
    certificateAuthorityKey: extractCertificateAuthorityKey(blob, type)
  }
}
export function fingerprintSshSha256(key: Buffer | SshPublicHostKey): string {
  const blob = Buffer.isBuffer(key) ? key : key.blob
  return `${SHA256_FINGERPRINT_PREFIX}${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
}
export function parseKnownHosts(content: string, source?: string): SshKnownHostEntry[] {
  const entries: SshKnownHostEntry[] = []
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const fields = line.split(/\s+/u)
    let fieldIndex = 0
    let marker: SshKnownHostMarker = 'direct'
    if (fields[fieldIndex]?.startsWith('@')) {
      const rawMarker = fields[fieldIndex]
      if (rawMarker !== '@revoked' && rawMarker !== '@cert-authority') {
        continue
      }
      marker = rawMarker === '@revoked' ? 'revoked' : 'cert-authority'
      fieldIndex += 1
    }
    const patternsField = fields[fieldIndex]
    const keyType = fields[fieldIndex + 1]
    const encodedKey = fields[fieldIndex + 2]
    if (!patternsField || !keyType || !encodedKey || keyType.startsWith('@')) {
      continue
    }
    const key = decodeKnownHostKey(encodedKey)
    if (!key) {
      continue
    }
    const parsedType = readSshString(key, 0)
    if (!parsedType || parsedType.value !== keyType) {
      continue
    }
    entries.push({
      marker,
      patterns: patternsField.split(','),
      keyType,
      key,
      comment: fields.slice(fieldIndex + 3).join(' ') || undefined,
      source
    })
  }
  return entries
}
export function readKnownHostsFiles(paths: readonly string[]): SshKnownHostEntry[] {
  const entries: SshKnownHostEntry[] = []
  for (const path of paths) {
    if (!path || !existsSync(path)) {
      continue
    }
    try {
      entries.push(...parseKnownHosts(readFileSync(path, 'utf8'), path))
    } catch {}
  }
  return entries
}
export function getDefaultSshKnownHostsPaths(): {
  user: string[]
  global: string[]
} {
  const userDirectory = join(homedir(), '.ssh')
  if (process.platform === 'win32') {
    return {
      user: [join(userDirectory, 'known_hosts')],
      global: [join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'ssh_known_hosts')]
    }
  }
  return {
    user: [join(userDirectory, 'known_hosts'), join(userDirectory, 'known_hosts2')],
    global: ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2']
  }
}
export function getAppSshKnownHostsPath(userDataPath: string): string {
  if (!userDataPath.trim()) {
    throw new Error('An app user-data path is required for app-owned SSH trust')
  }
  return join(userDataPath, DEFAULT_APP_KNOWN_HOSTS_RELATIVE_PATH)
}
export class AppSshKnownHostsStore {
  readonly path: string
  constructor(path: string) {
    if (!path.trim()) {
      throw new Error('An app-owned known_hosts path is required')
    }
    this.path = path
  }
  read(): SshKnownHostEntry[] {
    return readKnownHostsFiles([this.path])
  }
  add(endpoint: SshHostEndpoint, key: SshPublicHostKey): void {
    const current = readFileIfPresent(this.path)
    const existing = parseKnownHosts(current, this.path)
    if (
      existing.some(
        (entry) =>
          entry.marker === 'direct' &&
          entry.keyType === key.type &&
          entry.key.equals(key.blob) &&
          matchesKnownHostEntry(entry, endpoint)
      )
    ) {
      return
    }
    const hostToken = formatKnownHostsHost(endpoint)
    const line = `${hostToken} ${key.type} ${key.blob.toString('base64')} devbox-trusted ${key.fingerprint}\n`
    const next =
      current.length === 0 || current.endsWith('\n') ? `${current}${line}` : `${current}\n${line}`
    writeSecureFile(this.path, next)
  }
}
export function matchKnownHosts(
  entries: readonly SshKnownHostEntry[],
  endpoint: SshHostEndpoint,
  key: SshPublicHostKey
): SshKnownHostsMatch {
  const matchingEntries = entries.filter((entry) => matchesKnownHostEntry(entry, endpoint))
  const revoked = matchingEntries.find(
    (entry) =>
      entry.marker === 'revoked' &&
      ((entry.keyType === key.type && entry.key.equals(key.blob)) ||
        (key.certificateAuthorityKey != null && entry.key.equals(key.certificateAuthorityKey)))
  )
  if (revoked) {
    return { status: 'revoked', entry: revoked }
  }
  const certificateAuthorityMatch = matchingEntries.find(
    (entry) =>
      entry.marker === 'cert-authority' &&
      key.certificateAuthorityKey != null &&
      entry.key.equals(key.certificateAuthorityKey)
  )
  if (certificateAuthorityMatch) {
    return { status: 'trusted', entry: certificateAuthorityMatch }
  }
  const directMatch = matchingEntries.find(
    (entry) => entry.marker === 'direct' && entry.keyType === key.type && entry.key.equals(key.blob)
  )
  if (directMatch) {
    return { status: 'trusted', entry: directMatch }
  }
  const directEntries = matchingEntries.filter((entry) => entry.marker === 'direct')
  if (directEntries.length > 0) {
    return { status: 'changed', entries: directEntries }
  }
  return { status: 'unknown' }
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
function readFileIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
