import { describe, expect, it } from 'vitest'
import {
  DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT,
  mcpAuthCredentialRoot
} from './devbox-credential-sync'
import { devboxCredentialSyncRequests } from './devbox-credential-sync-requests'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const profile: DevboxProfileV1 = {
  schemaVersion: 3,
  id: 'roam',
  displayName: 'Credential roaming',
  sshTarget: {
    targetId: 'target-1',
    identity: { host: 'fixture', port: 22, username: 'user', hostKeyFingerprint: 'SHA256:x' }
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
        excludes: ['*.tmp']
      }
    ],
    defaultClassId: 'working',
    excludes: ['.git']
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 5_000,
    reconnectTargetMs: 15_000,
    operationRecoveryTargetMs: 30_000,
    offlineEdits: 'warn'
  }
}

describe('devboxCredentialSyncRequests', () => {
  it('returns no requests when credential sync is disabled', () => {
    expect(devboxCredentialSyncRequests(profile)).toEqual([])
    expect(
      devboxCredentialSyncRequests({
        ...profile,
        credentialSync: { enabled: false, roots: [] }
      })
    ).toEqual([])
  })

  it('emits the exact request shape for the mcp-auth root', () => {
    expect(
      devboxCredentialSyncRequests({
        ...profile,
        credentialSync: {
          enabled: true,
          roots: [mcpAuthCredentialRoot('/Users/sample', '/home/sample')]
        }
      })
    ).toEqual([
      {
        profileId: 'roam',
        sessionId: 'roam-credentials-mcp-auth',
        rootClassId: 'credentials',
        localRoot: '/Users/sample/.mcp-auth',
        remoteRoot: '/home/sample/.mcp-auth',
        mode: 'two-way-resolved',
        exclusionPolicy: 'explicit-only',
        maxEntryCount: DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT,
        excludes: [
          '*_code_verifier*.txt',
          '*_lock*.json',
          '*_debug*.log',
          '*.stale-*',
          '.DS_Store'
        ]
      }
    ])
  })

  it('creates distinct credential sessions for two roots', () => {
    const requests = devboxCredentialSyncRequests({
      ...profile,
      credentialSync: {
        enabled: true,
        roots: [
          {
            id: 'mcp-auth',
            localRoot: '/local/.mcp-auth',
            remoteRoot: '/remote/.mcp-auth',
            excludes: []
          },
          {
            id: 'provider-cache',
            localRoot: '/local/.provider-cache',
            remoteRoot: '/remote/.provider-cache',
            excludes: []
          }
        ]
      }
    })

    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.sessionId)).toEqual([
      'roam-credentials-mcp-auth',
      'roam-credentials-provider-cache'
    ])
    expect(new Set(requests.map((request) => request.sessionId)).size).toBe(2)
    expect(requests.map((request) => [request.localRoot, request.remoteRoot])).toEqual([
      ['/local/.mcp-auth', '/remote/.mcp-auth'],
      ['/local/.provider-cache', '/remote/.provider-cache']
    ])
  })

  it('de-duplicates excludes while preserving their order', () => {
    const [request] = devboxCredentialSyncRequests({
      ...profile,
      credentialSync: {
        enabled: true,
        roots: [
          {
            id: 'mcp-auth',
            localRoot: '/local/.mcp-auth',
            remoteRoot: '/remote/.mcp-auth',
            excludes: ['first', 'second', 'first', 'third', 'second']
          }
        ]
      }
    })

    expect(request?.excludes).toEqual(['first', 'second', 'third'])
  })
})
