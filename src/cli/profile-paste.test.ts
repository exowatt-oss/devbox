import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { normalizePasteRootPath } from '../core/devbox-paste-sync'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { formatDevboxStage, printDevboxResult } from './format'
import {
  disableDevboxProfilePaste,
  enableDevboxProfilePaste,
  showDevboxProfilePaste
} from './profile-paste'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'p1',
  displayName: 'p1',
  sshTarget: {
    targetId: 't1',
    identity: { host: 'host', port: 22, username: 'sample', hostKeyFingerprint: 'SHA256:abc123' }
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

const macTemp = '/tmp/devbox-paste'

function runner(output: string | Promise<string> = 'ready'): DevboxSshRunner {
  return {
    command: vi.fn(async () => await output),
    script: vi.fn(async () => '')
  }
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(join('/tmp', 'devbox-paste-'))
  expect(new DevboxProfileStore({ rootDir: root }).saveProfile(profile).status).toBe('saved')
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('profile paste mirroring', () => {
  it('defaults to mirroring this machine temp dir to the same remote path and prepares it', async () => {
    const root = await profileRoot()
    const ssh = runner()
    const result = await enableDevboxProfilePaste(root, {}, 'p1', { ssh })

    const localRoot = normalizePasteRootPath(tmpdir())
    expect(result).toEqual({
      profileId: 'p1',
      enabled: true,
      roots: [{ id: 'clipboard', localRoot, remoteRoot: localRoot, patterns: ['terminal-paste-*'] }],
      remoteRoot: { root: localRoot, status: 'ready' }
    })
    expect(ssh.command).toHaveBeenCalledTimes(1)
    const command = String(vi.mocked(ssh.command).mock.calls[0]?.[0])
    expect(command).toContain(`mkdir -p -- '${localRoot}'`)
    expect(command).toContain(`test -w '${localRoot}'`)
    expect(showDevboxProfilePaste(root, {}, 'p1')).toEqual({ ...result, remoteRoot: undefined })
  })

  it('turns an unwritable remote root into a sudo hint instead of failing', async () => {
    const root = await profileRoot()
    const result = await enableDevboxProfilePaste(root, {}, 'p1', { localRoot: macTemp, ssh: runner('unwritable') })

    expect(result.enabled).toBe(true)
    expect(result.remoteRoot).toEqual({
      root: macTemp,
      status: 'unwritable',
      hint: `On the remote host run: sudo mkdir -p '${macTemp}' && sudo chown -R 'sample' '${macTemp}'`
    })
  })

  it('reports an unreachable remote without losing the saved config', async () => {
    const root = await profileRoot()
    const result = await enableDevboxProfilePaste(root, {}, 'p1', {
      localRoot: macTemp,
      ssh: runner(Promise.reject(new Error('offline')))
    })

    expect(result.remoteRoot).toMatchObject({ root: macTemp, status: 'unreachable' })
    expect(result.remoteRoot?.hint).toContain('sudo mkdir -p')
    expect(showDevboxProfilePaste(root, {}, 'p1').enabled).toBe(true)
  })

  it('honours explicit roots, extra patterns, and the prepare skip', async () => {
    const root = await profileRoot()
    const ssh = runner()
    const result = await enableDevboxProfilePaste(root, {}, 'p1', {
      localRoot: `${macTemp}/`,
      remoteRoot: '/home/sample/.devbox/paste/',
      patterns: ['remote-paste-*'],
      skipRemotePrepare: true,
      ssh
    })

    expect(result.roots[0]).toEqual({
      id: 'clipboard',
      localRoot: macTemp,
      remoteRoot: '/home/sample/.devbox/paste',
      patterns: ['terminal-paste-*', 'remote-paste-*']
    })
    expect(result.remoteRoot).toEqual({ root: '/home/sample/.devbox/paste', status: 'skipped' })
    expect(ssh.command).not.toHaveBeenCalled()
  })

  it('flags a re-enable as an existing-root update and disables while keeping roots', async () => {
    const root = await profileRoot()
    await enableDevboxProfilePaste(root, {}, 'p1', { ssh: runner() })
    const again = await enableDevboxProfilePaste(root, {}, 'p1', { ssh: runner() })
    expect(again.updatedExistingRoot).toBe(true)

    const disabled = disableDevboxProfilePaste(root, {}, 'p1')
    expect(disabled).toEqual({ profileId: 'p1', enabled: false, roots: again.roots })
    expect(showDevboxProfilePaste(root, {}, 'p1')).toEqual(disabled)
  })

  it('shows disabled profiles without creating a root', async () => {
    const root = await profileRoot()
    expect(showDevboxProfilePaste(root, {}, 'p1')).toEqual({ profileId: 'p1', enabled: false, roots: [] })
  })

  it('renders human output with the remote fix and the next command', () => {
    const plain = { width: 120, env: { TERM: 'dumb' }, isTTY: false }
    const enabled = formatDevboxStage({
      profileId: 'p1',
      enabled: true,
      roots: [{ id: 'clipboard', localRoot: macTemp, remoteRoot: macTemp, patterns: ['terminal-paste-*'] }],
      remoteRoot: { root: macTemp, status: 'unwritable', hint: 'On the remote host run: sudo mkdir -p X' }
    }, 'paste-key', 'profile paste enable', plain)
    expect(enabled).toContain('Paste mirroring')
    expect(enabled).toContain(`clipboard: ${macTemp} -> ${macTemp}`)
    expect(enabled).toContain('patterns terminal-paste-*')
    expect(enabled).toContain('unwritable')
    expect(enabled).toContain('sudo mkdir -p X')
    expect(enabled).toMatch(/Run: devbox pair --profile p1$/u)

    const updated = formatDevboxStage({
      profileId: 'p1',
      enabled: true,
      updatedExistingRoot: true,
      roots: [{ id: 'clipboard', localRoot: macTemp, remoteRoot: macTemp, patterns: ['terminal-paste-*'] }],
      remoteRoot: { root: macTemp, status: 'ready' }
    }, 'paste-key', 'profile paste enable', plain)
    expect(updated).toMatch(/Run: devbox disable --profile p1 && devbox pair --profile p1$/u)

    const disabled = formatDevboxStage({ profileId: 'p1', enabled: false, roots: [] }, 'paste-key', 'profile paste show', plain)
    expect(disabled).toContain('Paste mirroring is disabled.')
    expect(disabled).not.toContain('Run:')
  })

  it('keeps the paste config in the stable JSON envelope', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const result = {
      profileId: 'p1',
      enabled: true,
      roots: [{ id: 'clipboard', localRoot: macTemp, remoteRoot: macTemp, patterns: ['terminal-paste-*'] }]
    }

    printDevboxResult('profile paste show', 'profile.paste.show', result, 'paste-key', true, formatDevboxStage)

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: 1,
      command: 'profile paste show',
      ok: true,
      operationKey: 'paste-key',
      result
    })
  })
})
