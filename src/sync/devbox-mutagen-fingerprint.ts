import { timingSafeEqual } from 'node:crypto'
import { utils } from 'ssh2'
import { fingerprintSshSha256 } from '../ssh/known-hosts'
import { decodeKnownHostKey } from '../ssh/known-hosts-matching'

function deriveFingerprint(algorithm: string, publicKey: string): string | undefined {
  const blob = decodeKnownHostKey(publicKey)
  if (!blob) {
    return undefined
  }
  try {
    const parsed = utils.parseKey(blob)
    if (parsed instanceof Error || parsed.type !== algorithm) {
      return undefined
    }
    return fingerprintSshSha256(blob)
  } catch {
    return undefined
  }
}

export function matchesDevboxMutagenSshFingerprint(
  algorithm: string,
  publicKey: string,
  expectedFingerprint: string
): boolean {
  const derivedFingerprint = deriveFingerprint(algorithm, publicKey)
  if (!derivedFingerprint) {
    return false
  }
  const derivedBytes = Buffer.from(derivedFingerprint)
  const expectedBytes = Buffer.from(expectedFingerprint)
  return (
    derivedBytes.length === expectedBytes.length && timingSafeEqual(derivedBytes, expectedBytes)
  )
}
