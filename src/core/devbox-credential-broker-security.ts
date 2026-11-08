import { createHash, generateKeyPairSync } from 'node:crypto'
import type {
  DevboxCredentialIdentity,
  DevboxCredentialProviderHost
} from './devbox-credential-broker-types'

const PRIMARY_SSH_PRIVATE_KEY_NAMES = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'identity'
])

export const PRIVATE_KEY_MATERIAL_PATTERN =
  /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/i

export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

export function generateDevboxCredentialIdentity(): DevboxCredentialIdentity {
  const generated = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'der', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
  })
  const publicKey = generated.publicKey.toString('base64')
  const identityRef = `devbox-ssh-${createHash('sha256').update(publicKey).digest('hex').slice(0, 20)}`
  return { identityRef, publicKey, privateKey: generated.privateKey }
}

export function defaultRevokeInstructions(
  provider: DevboxCredentialProviderHost['provider'],
  host: string
): string {
  if (provider === 'github') {
    return `On ${host}, open Settings → SSH and GPG keys and remove the Devbox key for this host.`
  }
  if (provider === 'gitlab') {
    return `On ${host}, open Preferences → SSH Keys and remove the Devbox key for this host.`
  }
  return `On ${host}, open the provider's SSH key or machine-identity settings and revoke the Devbox identity.`
}

export function isPrimarySshPrivateKeyPath(path: string): boolean {
  const normalized = path.trim().replaceAll('\\', '/')
  if (normalized.endsWith('.pub')) {
    return false
  }
  const parts = normalized.split('/')
  const sshIndex = parts.lastIndexOf('.ssh')
  const basename = parts.at(-1) ?? ''
  return sshIndex >= 0 && PRIMARY_SSH_PRIVATE_KEY_NAMES.has(basename)
}
