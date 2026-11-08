import type { DevboxSshIdentity } from '../../shared/devbox-types'

export const SECURITY_CANARIES = Object.freeze({
  machineSecret: 'synthetic-devbox-machine-secret-7f2a',
  generatedPrivateKey:
    '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----\nsynthetic-devbox-private-7f2a\n-----END ' + 'OPENSSH PRIVATE' + ' KEY-----',
  oauthReason: 'Bearer synthetic-devbox-oauth-7f2a',
  forwardedReason: 'authorization: Bearer synthetic-devbox-forwarded-7f2a',
  nestedToken: 'synthetic-devbox-nested-token-7f2a',
  workloadOutput: 'arbitrary-user-workload-output-7f2a'
})

export type SecurityCanaryName = keyof typeof SECURITY_CANARIES

export const SECURITY_HOST_IDENTITY: DevboxSshIdentity = Object.freeze({
  host: 'devbox.security.test',
  port: 2222,
  username: 'fixture-user',
  hostKeyFingerprint: 'SHA256:security-fixture-host'
})

export const SECURITY_HOST_BINDING = Object.freeze({
  profileTrusted: true,
  expected: SECURITY_HOST_IDENTITY,
  observed: SECURITY_HOST_IDENTITY
})

export const SECURITY_PROVIDER_HOST = Object.freeze({
  provider: 'github' as const,
  host: 'github.security.test'
})

export function allSecurityCanaries(): readonly string[] {
  return Object.values(SECURITY_CANARIES)
}

export function securityCanaryEntries(): readonly (readonly [SecurityCanaryName, string])[] {
  return Object.entries(SECURITY_CANARIES) as readonly (readonly [SecurityCanaryName, string])[]
}
