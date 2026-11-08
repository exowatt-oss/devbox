import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { formatDevboxStage, printDevboxResult } from './format'
import {
  disableDevboxProfileCredentials,
  enableDevboxProfileCredentials,
  showDevboxProfileCredentials
} from './profile-credentials'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'p1',
  displayName: 'p1',
  sshTarget: {
    targetId: 't1',
    identity: { host: 'host', port: 22, username: 'user', hostKeyFingerprint: 'SHA256:abc123' }
  },
  roots: { localRoot: '/local', remoteRoot: '/remote' },
  pathMap: [{ id: 'workspace', localRelativePath: '.', remoteRelativePath: '.', syncClassId: 'working' }],
  toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }],
    defaultClassId: 'working',
    excludes: []
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
}

function runner(output: string | Promise<string> = '/home/remote'): DevboxSshRunner {
  return {
    command: vi.fn(async () => await output),
    script: vi.fn(async () => '')
  }
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(join('/tmp', 'devbox-credentials-'))
  expect(new DevboxProfileStore({ rootDir: root }).saveProfile(profile).status).toBe('saved')
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('profile credential roaming', () => {
  it('enables credential sync with local and remote home defaults', async () => {
    const root = await profileRoot()
    const ssh = runner()
    const result = await enableDevboxProfileCredentials(root, {}, 'p1', { ssh })

    expect(result).toEqual({
      profileId: 'p1',
      enabled: true,
      roots: [{
        id: 'mcp-auth',
        localRoot: join(homedir(), '.mcp-auth'),
        remoteRoot: '/home/remote/.mcp-auth',
        excludes: ['*_code_verifier*.txt', '*_lock*.json', '*_debug*.log', '*.stale-*', '.DS_Store']
      }]
    })
    expect(ssh.command).toHaveBeenCalledWith('printf %s "$HOME"', 10_000)
    expect(showDevboxProfileCredentials(root, {}, 'p1')).toEqual(result)
  })

  it('marks an enable as an existing-root update when credentials were already enabled', async () => {
    const root = await profileRoot()
    await enableDevboxProfileCredentials(root, {}, 'p1', { ssh: runner() })

    const result = await enableDevboxProfileCredentials(root, {}, 'p1', { ssh: runner() })

    expect(result.updatedExistingRoot).toBe(true)
  })

  it('uses explicit roots and appends repeatable excludes without SSH resolution', async () => {
    const root = await profileRoot()
    const ssh = runner()
    const result = await enableDevboxProfileCredentials(root, {}, 'p1', {
      localRoot: '/custom/local/.mcp-auth',
      remoteRoot: '/custom/remote/.mcp-auth',
      excludes: ['*.tmp', '*_lock*.json'],
      ssh
    })

    expect(result.roots[0]).toMatchObject({
      localRoot: '/custom/local/.mcp-auth',
      remoteRoot: '/custom/remote/.mcp-auth',
      excludes: ['*_code_verifier*.txt', '*_lock*.json', '*_debug*.log', '*.stale-*', '.DS_Store', '*.tmp']
    })
    expect(ssh.command).not.toHaveBeenCalled()
  })

  it('maps remote-home resolution failures to the remote-root recovery field', async () => {
    const root = await profileRoot()
    const ssh = runner(Promise.reject(new Error('offline')))

    await expect(enableDevboxProfileCredentials(root, {}, 'p1', { ssh })).rejects.toMatchObject({
      code: 'operation_conflict',
      message: expect.stringContaining('--remote-root'),
      context: { field: 'credential-remote-home' }
    })
  })

  it('disables sync while preserving configured roots', async () => {
    const root = await profileRoot()
    const enabled = await enableDevboxProfileCredentials(root, {}, 'p1', { ssh: runner() })
    const disabled = disableDevboxProfileCredentials(root, {}, 'p1')

    expect(disabled).toEqual({ ...enabled, enabled: false })
    expect(showDevboxProfileCredentials(root, {}, 'p1')).toEqual(disabled)
  })

  it('shows disabled profiles without creating a credential root', async () => {
    const root = await profileRoot()
    expect(showDevboxProfileCredentials(root, {}, 'p1')).toEqual({
      profileId: 'p1',
      enabled: false,
      roots: []
    })
  })

  it('keeps credential config visible in the stable JSON result envelope', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const result = {
      profileId: 'p1',
      enabled: true,
      roots: [{ id: 'mcp-auth', localRoot: '/local/.mcp-auth', remoteRoot: '/remote/.mcp-auth', excludes: ['*.stale-*'] }]
    }

    printDevboxResult('profile credentials show', 'profile.credentials.show', result, 'credential-key', true, formatDevboxStage)

    const envelope = JSON.parse(String(output.mock.calls[0]?.[0])) as {
      schemaVersion: number
      command: string
      ok: boolean
      result: typeof result
    }
    expect(envelope).toEqual({
      schemaVersion: 1,
      command: 'profile credentials show',
      ok: true,
      operationKey: 'credential-key',
      result
    })
    expect(envelope.result.roots[0]?.localRoot).toBe('/local/.mcp-auth')
  })
})
