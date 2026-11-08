import { describe, expect, it } from 'vitest'
import {
  DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT,
  DEVBOX_MCP_AUTH_RELATIVE_DIR,
  DEVBOX_MCP_AUTH_ROOT_ID,
  defaultDevboxCredentialSyncConfig,
  disableDevboxCredentialSync,
  enableDevboxCredentialSync,
  mcpAuthCredentialRoot,
  normalizeDevboxCredentialSyncConfig,
  validateDevboxCredentialSyncConfig
} from './devbox-credential-sync'
import type { DevboxCredentialSyncRoot, DevboxProfileV1 } from '../shared/devbox-types'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'profile-1',
  displayName: 'Remote devbox',
  sshTarget: {
    targetId: 'target-1',
    identity: {
      host: 'devbox.example.test',
      port: 22,
      username: 'sample',
      hostKeyFingerprint: 'SHA256:abc123'
    }
  },
  roots: { localRoot: '/local/project', remoteRoot: '/remote/project' },
  pathMap: [],
  toolchain: { lockId: 'lock-1', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [
      {
        id: 'working',
        kind: 'portable-working',
        backend: 'mutagen',
        mode: 'two-way-safe',
        excludes: []
      }
    ],
    defaultClassId: 'working',
    excludes: []
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
  featureDefaults: { detachedJobs: false, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 10_000,
    reconnectTargetMs: 20_000,
    operationRecoveryTargetMs: 30_000,
    offlineEdits: 'warn'
  }
}

const root = (id: string, excludes: readonly string[] = []): DevboxCredentialSyncRoot => ({
  id,
  localRoot: `/local/${id}`,
  remoteRoot: `/remote/${id}`,
  excludes
})

describe('devbox credential sync contract', () => {
  it('provides a disabled default and the MCP auth constants', () => {
    expect(defaultDevboxCredentialSyncConfig()).toEqual({ enabled: false, roots: [] })
    expect(DEVBOX_MCP_AUTH_ROOT_ID).toBe('mcp-auth')
    expect(DEVBOX_MCP_AUTH_RELATIVE_DIR).toBe('.mcp-auth')
    expect(DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT).toBe(20_000)
  })

  it('builds the MCP auth root and de-duplicates custom excludes', () => {
    const result = mcpAuthCredentialRoot('/Users/sample', '/home/sample', [
      '*.stale-*',
      '*.custom'
    ])
    expect(result).toEqual({
      id: 'mcp-auth',
      localRoot: '/Users/sample/.mcp-auth',
      remoteRoot: '/home/sample/.mcp-auth',
      excludes: [
        '*_code_verifier*.txt',
        '*_lock*.json',
        '*_debug*.log',
        '*.stale-*',
        '.DS_Store',
        '*.custom'
      ]
    })
  })

  it('validates roots, rejects malformed ids and relative paths, and normalizes order', () => {
    const config = {
      enabled: true,
      roots: [
        root('z-root', ['*.log', '*.log', '.DS_Store']),
        root('a-root', ['first', 'first', 'second'])
      ]
    }
    expect(validateDevboxCredentialSyncConfig(config)).toBe(true)
    expect(normalizeDevboxCredentialSyncConfig(config)).toEqual({
      enabled: true,
      roots: [root('a-root', ['first', 'second']), root('z-root', ['*.log', '.DS_Store'])]
    })
    expect(validateDevboxCredentialSyncConfig({ ...config, roots: [root('Bad Root')] })).toBe(false)
    expect(
      validateDevboxCredentialSyncConfig({
        ...config,
        roots: [{ ...root('valid'), localRoot: 'relative' }]
      })
    ).toBe(false)
    expect(
      validateDevboxCredentialSyncConfig({
        ...config,
        roots: [root('same'), root('same')]
      })
    ).toBe(false)
  })

  it('enables by upserting a root and disables without dropping roots', () => {
    const first = root('mcp-auth', ['one', 'one'])
    const second = root('other')
    const enabled = enableDevboxCredentialSync(
      { ...profile, credentialSync: { enabled: false, roots: [first, second] } },
      root('mcp-auth', ['updated'])
    )
    expect(enabled).not.toBe(profile)
    expect(enabled.credentialSync).toEqual({
      enabled: true,
      roots: [root('mcp-auth', ['updated']), second]
    })
    const disabled = disableDevboxCredentialSync(enabled)
    expect(disabled).not.toBe(enabled)
    expect(disabled.credentialSync).toEqual({
      enabled: false,
      roots: enabled.credentialSync?.roots
    })
    expect(disableDevboxCredentialSync(profile).credentialSync).toEqual({ enabled: false, roots: [] })
  })

  it('reports the contract field for each invalid root category', () => {
    const cases: readonly [DevboxCredentialSyncRoot, string][] = [
      [{ ...root('Bad Root') }, 'credential-root-id'],
      [{ ...root('valid'), localRoot: 'relative' }, 'credential-root-absolute-paths'],
      [{ ...root('valid'), excludes: ['../secret'] }, 'credential-root-exclude']
    ]
    for (const [invalidRoot, field] of cases) {
      try {
        enableDevboxCredentialSync(profile, invalidRoot)
        expect.fail(`expected ${field}`)
      } catch (error) {
        expect(error).toMatchObject({
          code: 'operation_conflict',
          context: { field }
        })
      }
    }
  })
})
