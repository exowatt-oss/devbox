import { describe, expect, it, vi } from 'vitest'
import {
  DevboxPreflight,
  type DevboxExec,
  type DevboxExecRequest,
  type DevboxExecResult
} from './devbox-preflight'
import type { DevboxInventoryEntry } from './devbox-preflight-types'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const identity = {
  host: 'devbox.example',
  port: 22,
  username: 'sample',
  hostKeyFingerprint: 'SHA256:trusted'
}
const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'main',
  displayName: 'Main',
  sshTarget: { targetId: 'main', identity },
  roots: { localRoot: '/Users/sample/project', remoteRoot: '/home/sample/project' },
  pathMap: [],
  toolchain: { lockId: 'lock', lockSha256: 'a'.repeat(64) },
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
    syncLagTargetMs: 5_000,
    reconnectTargetMs: 15_000,
    operationRecoveryTargetMs: 30_000,
    offlineEdits: 'warn'
  }
}
const localEntries = [{ path: '/Users/sample/project/readme.md', kind: 'file' as const }]
const remoteEntries = [{ path: '/home/sample/project/readme.md', kind: 'file' as const }]

type FakeOptions = {
  os?: string
  platform?: 'Linux' | 'Darwin'
  machine?: string
  sudo?: number
  rsyncVersion?: string
  identity?: typeof identity
  freeBytes?: number
  freeInodes?: number
  local?: readonly DevboxInventoryEntry[]
  remote?: readonly DevboxInventoryEntry[]
  excludes?: readonly string[]
  limits?: string
}
function fakeExecs(options: FakeOptions = {}): {
  remote: DevboxExec
  local: DevboxExec
  requests: DevboxExecRequest[]
} {
  const requests: DevboxExecRequest[] = []
  const remote: DevboxExec = async (request) => {
    requests.push(request)
    const { command, args } = request
    if (command === 'printf') {
      return result('devbox-preflight-reachable', 0, options.identity ?? identity)
    }
    if (command === 'cat') {
      return result(options.os ?? 'ID=ubuntu\nVERSION_ID="22.04"\n')
    }
    if (command === 'uname') {
      return result(args.includes('-s') ? (options.platform ?? 'Linux') : (options.machine ?? 'x86_64'))
    }
    if (command === 'sw_vers') {
      return result('27.0')
    }
    if (command === 'sudo') {
      return result('', options.sudo ?? 0)
    }
    if (command === 'systemctl') {
      return result('running')
    }
    if (command === 'loginctl') {
      return result('yes')
    }
    if (command === 'bash' && args[0] === '--version') {
      return result('GNU bash')
    }
    if (command === 'bash') {
      return result(options.limits ?? 'unlimited\n4096\nunlimited\n')
    }
    if (command === 'python3' && args[0] === '--version') {
      return result('Python 3.12')
    }
    if (command === 'python3' && args[0] === '-c' && options.platform === 'Darwin') {
      return result('90000000000\n1000000\n')
    }
    if (command === 'python3') {
      return { ...result(''), entries: options.remote ?? remoteEntries }
    }
    if (command === 'df' && args.includes('--output=avail')) {
      return result(`${options.freeBytes ?? 90_000_000_000}\n`)
    }
    if (command === 'df') {
      return result(`${options.freeInodes ?? 1_000_000}\n`)
    }
    if (command === 'rsync' && args[0] === '--version') {
      return result(options.rsyncVersion ?? 'rsync version 3.2.7\nCompression: zstd lz4 zlib')
    }
    if (command === 'rsync') {
      return result('')
    }
    return result('', 127)
  }
  const local: DevboxExec = async (request) => {
    requests.push(request)
    if (request.command === 'python3') {
      return { ...result(''), entries: options.local ?? localEntries }
    }
    return result('', 127)
  }
  return { remote, local, requests }
}
function result(
  stdout: string,
  exitCode = 0,
  observedIdentity?: typeof identity
): DevboxExecResult {
  return {
    stdout,
    stderr: '',
    exitCode,
    ...(observedIdentity ? { identity: observedIdentity } : {})
  }
}
function make(
  options: FakeOptions = {},
  clock = () => 100
): { preflight: DevboxPreflight; requests: DevboxExecRequest[] } {
  const fakes = fakeExecs(options)
  return {
    preflight: new DevboxPreflight(options.excludes ? { ...profile, sync: { ...profile.sync, excludes: options.excludes } } : profile, {
      remoteExec: fakes.remote,
      localExec: fakes.local,
      clock
    }),
    requests: fakes.requests
  }
}
const capacity = {
  leanSeedBytes: 1,
  trackedRestoreBytes: 2,
  syncStagingBytes: 3,
  runtimeGenerationBytes: 4,
  consistentWorkspaceBytes: 5,
  blockReserveBytes: 6,
  inodeReserve: 7
}

async function run(options: FakeOptions = {}, capacityOverride = capacity) {
  const fixture = make(options)
  return {
    result: await fixture.preflight.run({ operationId: 'op-1', capacity: capacityOverride }),
    requests: fixture.requests
  }
}

describe('DevboxPreflight', () => {
  it('performs only read-only probes and emits the mutation preview', async () => {
    const { result: assessment, requests } = await run()
    expect(assessment.status).toBe('ready')
    expect(
      requests.filter(
        ({ command, args }) =>
          /^(mkdir|write|rm|touch)$/.test(command) ||
          (command === 'rsync' && args[0] !== '--version' && !args.includes('--dry-run'))
      )
    ).toHaveLength(0)
    expect(assessment.preview.privilegedCommands.map(({ command }) => command)).toEqual([
      'sudo',
      'loginctl',
      'sudo'
    ])
    expect(assessment.preview.downloads).toHaveLength(1)
    expect(assessment.preview.writes.map(({ path }) => path)).toContain(
      '/home/sample/.local/state/devbox/main'
    )
  })

  it('accepts a macOS arm64 hub without systemd or GNU df', async () => {
    const { result: assessment } = await run({ platform: 'Darwin' })
    expect(assessment.status).toBe('ready')
    expect(assessment.checks.find(({ id }) => id === 'os-distro-arch')).toMatchObject({ status: 'pass', details: { distro: 'darwin', release: '27.0', arch: 'x86_64' } })
    expect(assessment.checks.find(({ id }) => id === 'systemd-user-manager')).toMatchObject({ status: 'pass', details: { detail: 'not-applicable: darwin' } })
    expect(assessment.checks.find(({ id }) => id === 'user-linger')).toMatchObject({ status: 'pass', details: { detail: 'not-applicable: darwin' } })
    expect(assessment.preview.privilegedCommands).toEqual([{ command: 'brew', args: ['install', 'rsync'], reason: 'only if reviewed capability repair is approved' }])
  })

  it('accepts the macOS default 256 soft fd limit when the hard limit can be raised', async () => {
    const { result: assessment } = await run({ platform: 'Darwin', limits: '4000\n256\nunlimited\n' })
    expect(assessment.status).toBe('ready')
    expect(assessment.checks.find(({ id }) => id === 'ulimit')).toMatchObject({
      status: 'pass',
      details: { nproc: '4000', fileDescriptors: '256', hardFileDescriptors: 'unlimited' }
    })
  })

  it('still blocks a Linux hub whose soft fd limit is below budget', async () => {
    const { result: assessment } = await run({ limits: '4000\n256\nunlimited\n' })
    expect(assessment.status).toBe('blocked')
    expect(assessment.checks.find(({ id }) => id === 'ulimit')).toMatchObject({ status: 'fail' })
  })

  it.each(['aarch64', 'arm64'])('accepts an Ubuntu %s hub (AWS Graviton)', async (machine) => {
    const { result: assessment } = await run({ machine })
    expect(assessment.status).toBe('ready')
    expect(assessment.checks.find(({ id }) => id === 'os-distro-arch')).toMatchObject({ status: 'pass', details: { distro: 'ubuntu', arch: machine } })
  })

  it('still blocks an Ubuntu hub on an unsupported architecture', async () => {
    const { result: assessment } = await run({ machine: 'riscv64' })
    expect(assessment.status).toBe('blocked')
    expect(assessment.blockedReason).toBe('unsupported-os')
  })

  it('stops on an unsupported OS with an exact reason', async () => {
    const { result: assessment } = await run({ os: 'ID=debian\nVERSION_ID="12"\n' })
    expect(assessment.status).toBe('blocked')
    expect(assessment.blockedReason).toBe('unsupported-os')
    expect(assessment.checks.find(({ id }) => id === 'os-distro-arch')).toMatchObject({
      status: 'fail',
      remediation: expect.stringContaining('Ubuntu 22.04 or 24.04')
    })
  })

  it.each([
    [{ sudo: 1 }, 'missing-sudo', 'non-interactive sudo'],
    [
      { rsyncVersion: 'rsync version 3.2.7\nCompression: zlib' },
      'insufficient-rsync',
      '--compress-choice=zstd'
    ],
    [{ freeBytes: 1 }, 'byte-deficit', 'byte or inode deficit'],
    [{ freeInodes: 1 }, 'inode-deficit', 'byte or inode deficit']
  ])('blocks actionable preflight failures %#', async (options, reason, text) => {
    const { result: assessment } = await run(options)
    expect(assessment.status).toBe('blocked')
    expect(assessment.blockedReason).toBe(reason)
    expect(assessment.blockers.some(({ remediation }) => remediation.includes(text))).toBe(true)
  })

  it('fails closed on a changed endpoint or host key', async () => {
    const { result: assessment } = await run({
      identity: { ...identity, hostKeyFingerprint: 'SHA256:changed' }
    })
    expect(assessment.status).toBe('blocked')
    expect(assessment.blockedReason).toBe('ssh-identity-mismatch')
    expect(assessment.checks.find(({ id }) => id === 'host-identity')?.error?.code).toBe(
      'ssh_identity_mismatch'
    )
  })

  it('reports case and Unicode collision candidates through the path mapper', async () => {
    const { result: assessment } = await run({
      local: [
        { path: '/Users/sample/project/Foo', kind: 'file' },
        { path: '/Users/sample/project/foo', kind: 'file' }
      ]
    })
    expect(assessment.status).toBe('blocked')
    expect(assessment.pathIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'case-or-unicode-collision',
          candidates: expect.arrayContaining([
            '/Users/sample/project/Foo',
            '/Users/sample/project/foo'
          ])
        })
      ])
    )
  })

  it('preserves NFC/NFD collision detection in the preflight path stage', async () => {
    const decomposed = '/Users/sample/project/cafe\u0301.txt'
    const composed = '/Users/sample/project/caf\u00e9.txt'
    const { result: assessment } = await run({
      local: [
        { path: decomposed, kind: 'file' },
        { path: composed, kind: 'file' }
      ]
    })
    expect(assessment.status).toBe('blocked')
    expect(assessment.pathIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'case-or-unicode-collision',
          candidates: expect.arrayContaining([decomposed, composed])
        })
      ])
    )
  })

  it('warns, rather than blocks, for ignored collisions and out-of-root symlinks', async () => {
    const { result: assessment } = await run({
      excludes: ['ignored/'],
      local: [
        { path: '/Users/sample/project/ignored/Foo', kind: 'file' },
        { path: '/Users/sample/project/ignored/foo', kind: 'file' },
        { path: '/Users/sample/project/link', kind: 'symlink', target: '/outside' }
      ]
    })
    expect(assessment.status).toBe('ready')
    expect(assessment.checks.find(({ id }) => id === 'path-safety')).toMatchObject({ status: 'warn', blocking: false })
    expect(assessment.pathIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'ignored-case-or-unicode-collision', severity: 'warn' }),
      expect.objectContaining({ reason: 'out-of-root-link', severity: 'warn' })
    ]))
  })

  it('returns a resumable stage list after cancellation mid-stage', async () => {
    const controller = new AbortController()
    let release: (() => void) | undefined
    const remote: DevboxExec = async (request) => {
      await new Promise<void>((resolve, reject) => {
        release = resolve
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
      return result('')
    }
    const local: DevboxExec = vi.fn(async () => result(''))
    const preflight = new DevboxPreflight(profile, {
      remoteExec: remote,
      localExec: local,
      clock: () => 100
    })
    const pending = preflight.run({ operationId: 'cancelled', signal: controller.signal })
    controller.abort()
    release?.()
    const assessment = await pending
    expect(assessment.status).toBe('cancelled')
    expect(assessment.operation.phase).toBe('cancelled')
    expect(
      assessment.stages.some(({ status, resumable }) => status === 'cancelled' && resumable)
    ).toBe(true)
    expect(assessment.stages.some(({ status }) => status === 'pending')).toBe(true)
  })
})
