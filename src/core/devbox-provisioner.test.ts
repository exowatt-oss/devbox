import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxToolchainLockV1 } from '../shared/devbox-toolchain-lock'
import { DevboxOperationJournal } from './devbox-operation-journal'
import {
  DevboxProvisioner,
  type DevboxProvisionExecRequest,
  type DevboxProvisionState
} from './devbox-provisioner'

const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'main',
  displayName: 'Main',
  sshTarget: {
    targetId: 'main',
    identity: {
      host: 'devbox.test',
      port: 22,
      username: 'sample',
      hostKeyFingerprint: 'SHA256:test'
    }
  },
  roots: { localRoot: '/Users/sample/project', remoteRoot: '/home/sample/project' },
  pathMap: [],
  toolchain: { lockId: 'lock-1', lockSha256: 'a'.repeat(64) },
  sync: {
    classes: [
      {
        id: 'working',
        kind: 'portable-working',
        backend: 'rsync-fallback',
        mode: 'two-way-safe',
        excludes: []
      }
    ],
    defaultClassId: 'working',
    excludes: []
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 5000,
    reconnectTargetMs: 15000,
    operationRecoveryTargetMs: 30000,
    offlineEdits: 'warn'
  }
}
const artifact = (name: 'phi-archive' | 'node' | 'uv' | 'mutagen', value: string) => ({
  name,
  version: '1.0.0',
  sha256: createHash('sha256').update(value).digest('hex'),
  sourceUrl: `https://cache.test/${name}`,
  platform: 'linux-x64' as const
})
const lock: DevboxToolchainLockV1 = {
  schemaVersion: 1,
  lockId: 'lock-1',
  immutable: true,
  artifacts: [
    artifact('phi-archive', 'phi'),
    artifact('node', 'node'),
    artifact('uv', 'uv'),
    artifact('mutagen', 'mutagen')
  ]
}
const cache = {
  'phi-archive': new Uint8Array(Buffer.from('phi')),
  node: new Uint8Array(Buffer.from('node')),
  uv: new Uint8Array(Buffer.from('uv')),
  mutagen: new Uint8Array(Buffer.from('mutagen'))
}
function fixture(overrides: { sudo?: boolean; failGeneration?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devbox-provision-')),
    requests: DevboxProvisionExecRequest[] = [],
    state: DevboxProvisionState = {
      files: {},
      verifiedGenerations: [],
      backups: [],
      sudoAuthorized: overrides.sudo ?? true
    },
    journal = new DevboxOperationJournal({
      journalPath: join(root, 'journal.jsonl')
    })
  let failed = overrides.failGeneration ?? false
  const remote = async (request: DevboxProvisionExecRequest) => {
    requests.push({ ...request, stdin: request.stdin ? new Uint8Array(request.stdin) : undefined })
    if (request.command === 'devbox-state') {
      return { exitCode: 0, stdout: JSON.stringify(state), stderr: '' }
    }
    if (request.command === 'sudo') {
      return {
        exitCode: request.args[0] === '-n' && !state.sudoAuthorized ? 1 : 0,
        stdout: '',
        stderr: ''
      }
    }
    if (
      request.command === 'bash' &&
      request.stdin?.length &&
      Buffer.from(request.stdin).toString().includes('MANIFEST.sha256')
    ) {
      if (failed) {
        failed = false
        return { exitCode: 1, stdout: '', stderr: 'interrupted' }
      }
      const digest = request.args[request.args.indexOf('--') + 2]!
      state.currentGeneration = digest
      state.verifiedGenerations = [...new Set([...(state.verifiedGenerations ?? []), digest])]
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (request.command === 'bash') {
      state.backups = [...(state.backups ?? []), request.args[request.args.indexOf('--') + 1]!]
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (request.command === 'devbox-write-file') {
      state.files = { ...state.files, [request.args[0]!]: request.args[1]! }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const provisioner = new DevboxProvisioner(profile, {
    remoteExec: remote,
    journal,
    clock: () => 100,
    secureSudoPrompt: async () => 'ultra-secret',
    readState: async () => state
  })
  return { root, requests, state, journal, provisioner }
}
const options = {
  operationId: 'op-1',
  lock,
  artifactCache: cache,
  files: [
    { path: '/home/sample/.pi/settings.json', content: '{}', kind: 'config' as const },
    { path: '/home/sample/.bashrc.d/devbox.sh', content: '# devbox', kind: 'shell' as const }
  ]
}

describe('DevboxProvisioner', () => {
  it('creates a backup before modifying writes and becomes a verified no-op on the second run', async () => {
    const f = fixture()
    const first = await f.provisioner.provision(options),
      requestCommands = f.requests.map(({ command }) => command)
    expect(first.status).toBe('completed')
    expect(requestCommands.indexOf('bash')).toBeLessThan(
      requestCommands.indexOf('devbox-upload-artifact')
    )
    expect(first.stages.every(({ status }) => status === 'completed')).toBe(true)
    const before = f.requests.length
    const second = await f.provisioner.provision(options)
    expect(second.status).toBe('completed')
    expect(f.requests.length).toBe(before)
    expect(second.previousGeneration).toBeUndefined()
  })

  it('resumes an interrupted stage from the checksummed journal', async () => {
    const f = fixture({ failGeneration: true })
    const first = await f.provisioner.provision(options)
    expect(first.status).toBe('blocked')
    expect(first.stages.find(({ id }) => id === 'generation')?.status).toBe('blocked')
    const second = await f.provisioner.provision(options)
    expect(second.status).toBe('completed')
    expect(second.stages.filter(({ status }) => status === 'completed')).toHaveLength(8)
    expect(
      f.journal.replay().operations.some(({ operationId }) => operationId === 'op-1:backup')
    ).toBe(true)
  })

  it('uses one bounded secure sudo prompt without exposing its secret', async () => {
    const f = fixture({ sudo: false })
    f.state.sudoAuthorized = false
    const result = await f.provisioner.provision(options)
    expect(result.status).toBe('completed')
    const serialized =
      JSON.stringify(f.requests) + readFileSync(join(f.root, 'journal.jsonl'), 'utf8')
    expect(serialized).not.toContain('ultra-secret')
    expect(f.requests.filter(({ command }) => command === 'sudo')).toHaveLength(2)
    expect(
      f.requests.find(({ command, args }) => command === 'sudo' && args[0] === '-S')?.args
    ).not.toContain('ultra-secret')
  })

  it('rejects a local artifact digest mismatch before any install or generation write', async () => {
    const f = fixture()
    const bad = { ...cache, node: new Uint8Array(Buffer.from('tampered')) }
    const result = await f.provisioner.provision({ ...options, artifactCache: bad })
    expect(result.status).toBe('blocked')
    expect(result.error?.code).toBe('toolchain_digest_invalid')
    expect(f.requests.map(({ command }) => command)).toEqual([])
  })

  it('switches generations atomically while retaining the previous verified generation and restores backups', async () => {
    const f = fixture()
    f.state.currentGeneration = 'old-generation'
    f.state.verifiedGenerations = ['old-generation']
    const result = await f.provisioner.provision(options)
    expect(result.previousGeneration).toBe('old-generation')
    const generation = f.requests.find(
      ({ command, stdin }) =>
        command === 'bash' && stdin && Buffer.from(stdin).toString().includes('MANIFEST.sha256')
    )
    expect(generation?.args).toContain('-s')
    expect(Buffer.from(generation?.stdin ?? []).toString()).toContain('mv -f')
    expect(f.state.verifiedGenerations).toContain('old-generation')
    expect((await f.provisioner.restoreBackup(result.backupPath)).status).toBe('restored')
  })
})
