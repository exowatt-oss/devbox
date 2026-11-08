import { describe, expect, it } from 'vitest'
import {
  DEVBOX_ALWAYS_EXCLUDED_SECRET_PATHS,
  DEVBOX_CREDENTIAL_CAPABILITY_CLASSES,
  DEVBOX_PATH_CLASSIFIER_LIMITATION,
  classifyDevboxWorkspacePath,
  createDevboxCredentialCapabilityReference,
  createDevboxCredentialHostReference,
  createDevboxCredentialStatusReference,
  isDevboxCredentialCapability,
  type DevboxCredentialCapability
} from './devbox-credential-types'

describe('Devbox credential capability contracts', () => {
  it('exposes the closed four-class capability union', () => {
    expect(DEVBOX_CREDENTIAL_CAPABILITY_CLASSES).toEqual([
      'forwarded-only',
      'machine-enrolled',
      'oauth-per-host',
      'unavailable'
    ])

    const capabilities: DevboxCredentialCapability[] = [
      {
        class: 'forwarded-only',
        capabilityRef: createDevboxCredentialCapabilityReference('ssh-agent-forwarding'),
        statusRef: createDevboxCredentialStatusReference('status-ssh-agent'),
        status: 'available',
        connectionRef: createDevboxCredentialHostReference('connection-main')
      },
      {
        class: 'machine-enrolled',
        capabilityRef: createDevboxCredentialCapabilityReference('github-machine'),
        statusRef: createDevboxCredentialStatusReference('status-github-machine'),
        status: 'required',
        enrollmentRef: createDevboxCredentialCapabilityReference('enrollment-github-main'),
        hostRef: createDevboxCredentialHostReference('host-main-sample-devbox')
      },
      {
        class: 'oauth-per-host',
        capabilityRef: createDevboxCredentialCapabilityReference('mcp-oauth-grafana'),
        statusRef: createDevboxCredentialStatusReference('status-mcp-grafana'),
        status: 'expired',
        authorizationRef: createDevboxCredentialCapabilityReference('auth-grafana-main'),
        hostRef: createDevboxCredentialHostReference('host-main-sample-devbox')
      },
      {
        class: 'unavailable',
        capabilityRef: createDevboxCredentialCapabilityReference('cloud-credential'),
        statusRef: createDevboxCredentialStatusReference('status-cloud-credential'),
        status: 'blocked',
        reason: 'provider-unsupported'
      }
    ]

    expect(capabilities.every(isDevboxCredentialCapability)).toBe(true)
  })

  it('rejects secret-shaped references and unknown fields at the value boundary', () => {
    expect(() => createDevboxCredentialCapabilityReference('token=synthetic-canary')).toThrow(
      'opaque reference'
    )
    expect(
      isDevboxCredentialCapability({
        class: 'machine-enrolled',
        capabilityRef: 'machine-ref',
        statusRef: 'status-ref',
        status: 'available',
        enrollmentRef: 'enrollment-ref',
        hostRef: 'host-ref',
        value: 'synthetic-devbox-canary'
      })
    ).toBe(false)
    expect(
      isDevboxCredentialCapability({
        class: 'unavailable',
        capabilityRef: 'cloud-ref',
        statusRef: 'cloud-status',
        status: 'available',
        reason: 'provider-unsupported'
      })
    ).toBe(false)
  })
})

describe('Devbox generic-sync secret path classifier', () => {
  it('classifies every canonical secret-bearing path as excluded', () => {
    for (const path of DEVBOX_ALWAYS_EXCLUDED_SECRET_PATHS) {
      const result = classifyDevboxWorkspacePath(path)
      expect(result.class, path).toBe('excluded-from-generic-sync')
      expect(result.matchedRule, path).toBeDefined()
      expect(result.detectionScope).toBe('path-only')
      expect(result.canDetectEveryEmbeddedSecret).toBe(false)
    }
  })

  it('matches absolute and workspace-relative forms of declared paths', () => {
    expect(classifyDevboxWorkspacePath('/Users/tester/.pi/agent/auth.json').class).toBe(
      'excluded-from-generic-sync'
    )
    expect(classifyDevboxWorkspacePath('workspace/.mcp-auth/session_lock.json').class).toBe(
      'excluded-from-generic-sync'
    )
    expect(classifyDevboxWorkspacePath('project/certs/service.pem').class).toBe(
      'excluded-from-generic-sync'
    )
  })

  it('warns on an unknown secret-like path without claiming content detection', () => {
    const result = classifyDevboxWorkspacePath('workspace/config/client-token-canary.json')
    expect(result.class).toBe('warning')
    expect(result.classification).toBe('warning')
    expect(result.warning).toBe('secret-like-path')
    expect(result.detectionScope).toBe('path-only')
    expect(result.canDetectEveryEmbeddedSecret).toBe(false)
    expect(DEVBOX_PATH_CLASSIFIER_LIMITATION).toContain('embedded secrets')
  })

  it('does not warn on ordinary source paths', () => {
    expect(classifyDevboxWorkspacePath('src/devbox/status.ts').class).toBe('not-secret-like')
  })
})
