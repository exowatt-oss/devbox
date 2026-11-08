import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MUTAGEN_JSON_TEMPLATE,
  MutagenCli,
  parseMutagenMonitorOutput,
  type MutagenCommandRunner,
  type MutagenSessionRecord
} from './mutagen-cli'
import { MUTAGEN_RELEASE_PINS } from './mutagen-release-pins'
import type { DevboxToolchainLockV1 } from '../shared/devbox-toolchain-lock'

const request = {
  profileId: 'profile-1',
  sessionId: 'session-1',
  rootClassId: 'working',
  localRoot: '/local/project',
  remoteRoot: '/remote/project',
  mode: 'two-way-safe' as const
}

const session: MutagenSessionRecord = {
  identifier: 'mutagen-identifier-1',
  name: 'devbox-working-session-1',
  labels: {
    'devbox-profile': 'profile-1',
    'devbox-session': 'session-1',
    'devbox-root-class': 'working',
    'devbox-backend': 'mutagen'
  },
  paused: false,
  status: 'watching',
  successfulCycles: 1,
  conflicts: [],
  watch: { mode: 'portable', native: true, pollingInterval: 10 },
  lastChangeAt: null,
  lastSynchronizedAt: null
}

function lockFor(platform: 'darwin_arm64' | 'darwin_amd64' | 'linux_amd64'): DevboxToolchainLockV1 {
  const pin = MUTAGEN_RELEASE_PINS[platform]
  return {
    schemaVersion: 1,
    lockId: 'lock-1',
    immutable: true,
    artifacts: [
      {
        name: 'mutagen',
        version: pin.version,
        sha256: pin.sha256,
        sourceUrl: pin.sourceUrl,
        platform: pin.lockPlatform
      },
      {
        name: 'node',
        version: '22.0.0',
        sha256: 'b'.repeat(64),
        sourceUrl: 'https://example.test/node.tar.gz',
        platform: pin.lockPlatform
      },
      {
        name: 'phi-archive',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sourceUrl: 'https://example.test/phi.tar.gz',
        platform: pin.lockPlatform
      },
      {
        name: 'uv',
        version: '0.6.0',
        sha256: 'c'.repeat(64),
        sourceUrl: 'https://example.test/uv.tar.gz',
        platform: pin.lockPlatform
      }
    ]
  }
}

describe('MutagenCli', () => {
  it('emits isolated argv and templated state reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-cli-'))
    try {
      const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
      const runner = vi
        .fn<MutagenCommandRunner>()
        .mockImplementation(async (command, args, options) => {
          calls.push({ command, args, env: options.env })
          if (args[0] === 'sync' && args[1] === 'list') {
            return { exitCode: 0, stdout: JSON.stringify([session]), stderr: '' }
          }
          if (args[0] === 'sync' && args[1] === 'monitor') {
            return { exitCode: 0, stdout: `${JSON.stringify([session])}\n`, stderr: '' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        })
      const dataDirectory = resolve(root, 'app-data', 'mutagen')
      const cli = new MutagenCli({
        binaryPath: resolve(root, 'bin', 'mutagen'),
        appDataRoot: resolve(root, 'app-data'),
        dataDirectory,
        profileId: request.profileId,
        commandRunner: runner
      })
      await cli.createSession(request, {
        remoteEndpoint: 'sample@devbox-mutagen-profile-1:/remote/project',
        name: 'devbox-working-session-1',
        labels: session.labels
      })
      await cli.monitor(session.identifier)
      await cli.pause(session.identifier)
      await cli.terminate(session.identifier)
      await expect(cli.terminate('--all')).rejects.toMatchObject({ code: 'operation_conflict' })

      expect(calls[0]?.command).toBe(resolve(root, 'bin', 'mutagen'))
      const createArgs = calls[0]?.args ?? []
      expect(createArgs).toEqual(
        expect.arrayContaining([
          '--no-global-configuration',
          '--mode=two-way-safe',
          '--ignore-vcs',
          '--permissions-mode=portable',
          '--default-file-mode=0600',
          '--default-directory-mode=0700',
          '--symlink-mode=portable',
          '--watch-mode=portable',
          '--watch-polling-interval=10',
          '--stage-mode=neighboring',
          '--max-entry-count=2000000'
        ])
      )
      for (const call of calls) {
        expect(call.env.MUTAGEN_DATA_DIRECTORY).toBe(dataDirectory)
        if (call.args.includes('list') || call.args.includes('monitor')) {
          expect(call.args).toContain(`--template=${MUTAGEN_JSON_TEMPLATE}`)
        }
        if (!call.args.includes('create')) {
          expect(call.args).not.toContain('--no-global-configuration')
        }
      }
      expect(calls.flatMap((call) => call.args)).not.toContain('--all')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed concatenated monitor frames', () => {
    expect(() => parseMutagenMonitorOutput(`${JSON.stringify([session])}not-json`)).toThrow()
    expect(() => parseMutagenMonitorOutput('')).toThrow()
  })

  it('fails closed on a Mutagen version or digest mismatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-lock-'))
    try {
      const cli = new MutagenCli({
        binaryPath: resolve(root, 'mutagen'),
        dataDirectory: resolve(root, 'app', 'mutagen'),
        appDataRoot: resolve(root, 'app'),
        profileId: 'profile-1',
        commandRunner: vi.fn<MutagenCommandRunner>()
      })
      await expect(
        cli.upgrade({
          newBinaryPath: resolve(root, 'new-mutagen'),
          lock: {
            ...lockFor('linux_amd64'),
            artifacts: lockFor('linux_amd64').artifacts.map((artifact) =>
              artifact.name === 'mutagen' ? { ...artifact, version: '0.18.0' } : artifact
            )
          },
          platform: 'linux_amd64',
          snapshotDataDirectory: async () => ({}),
          restoreDataDirectory: async () => undefined,
          recreateAndVerify: async () => undefined
        })
      ).rejects.toMatchObject({ code: 'toolchain_digest_invalid' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores binary and data when an upgrade verification fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-mutagen-upgrade-'))
    try {
      const calls: string[] = []
      const runner = vi.fn<MutagenCommandRunner>().mockImplementation(async (_command, args) => {
        calls.push(args.join(' '))
        if (args[0] === 'sync' && args[1] === 'list') {
          return { exitCode: 0, stdout: JSON.stringify([session]), stderr: '' }
        }
        if (args[0] === 'sync' && args[1] === 'monitor') {
          return { exitCode: 0, stdout: `${JSON.stringify([session])}\\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      })
      const cli = new MutagenCli({
        binaryPath: resolve(root, 'old-mutagen'),
        dataDirectory: resolve(root, 'app', 'mutagen'),
        appDataRoot: resolve(root, 'app'),
        profileId: 'profile-1',
        commandRunner: runner
      })
      const snapshot = { marker: 'old-data' }
      const restoreDataDirectory = vi.fn(async (_snapshot: unknown) => undefined)
      const restoreBinary = vi.fn(async () => undefined)
      await expect(
        cli.upgrade({
          newBinaryPath: resolve(root, 'new-mutagen'),
          lock: lockFor('linux_amd64'),
          platform: 'linux_amd64',
          snapshotDataDirectory: async () => snapshot,
          restoreDataDirectory,
          installBinary: async () => {
            calls.push('install-new')
          },
          restoreBinary,
          recreateAndVerify: async () => {
            throw new Error('verification failed')
          }
        })
      ).rejects.toThrow('verification failed')
      expect(restoreDataDirectory).toHaveBeenCalledWith(snapshot)
      expect(restoreBinary).toHaveBeenCalledTimes(1)
      expect(cli.currentBinaryPath).toBe(resolve(root, 'old-mutagen'))
      expect(calls).toContain('install-new')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
