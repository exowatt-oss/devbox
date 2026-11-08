import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeMutagenDaemon } from './mutagen-daemon-probe'
import * as mutagenService from './mutagen-service'

type Result = { exitCode: number; stdout: string; stderr: string }

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'devbox-mutagen-probe-'))
}

function ok(stdout = ''): Result {
  return { exitCode: 0, stdout, stderr: '' }
}

describe('Mutagen daemon probe', () => {
  let root: string | undefined
  afterEach(() => { if (root) {rmSync(root, { recursive: true, force: true });} root = undefined })

  it('selects the app-private linux daemon and identifies service ancestry', async () => {
    root = tempRoot()
    const dataDirectory = join(root, 'mutagen')
    const archives = join(dataDirectory, 'archives')
    const older = join(archives, 'old')
    const newer = join(archives, 'new')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(archives, { recursive: true })
    writeFileSync(older, 'old')
    writeFileSync(newer, 'new')
    const oldTime = new Date(Date.now() - 10_000)
    const newTime = new Date(Date.now() - 1_000)
    utimesSync(older, oldTime, oldTime)
    utimesSync(newer, newTime, newTime)
    const exec = async (command: string, args: readonly string[]): Promise<Result> => {
      if (command === 'ps' && args[0] === '-axo') {return ok('100 500 /opt/mutagen daemon run\n200 1 /Users/sample/.mutagen/bin/mutagen daemon run\n')}
      if (command === 'sh') {return args[1]?.includes('/proc/100/') ? ok(`PATH=/usr/bin\nMUTAGEN_DATA_DIRECTORY=${dataDirectory}\n`) : ok('PATH=/usr/bin\n')}
      if (command === 'ps' && args[0] === '-o') {return ok('500\n')}
      if (command === '/opt/mutagen') {return ok('Mutagen v0.18.1\n')}
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    }
    const probe = await probeMutagenDaemon({ dataDirectory, binaryPath: '/opt/mutagen', platform: 'linux', servicePid: 500, exec })
    expect(probe).toMatchObject({ running: true, pid: 100, origin: 'service', version: 'Mutagen v0.18.1', binaryPath: '/opt/mutagen', dataDirectory })
    expect(probe.lastCycleAt).toBeCloseTo(newTime.getTime(), 0)
  })

  it('uses the default service executor when exec is omitted', async () => {
    root = tempRoot()
    const calls: string[] = []
    const executor = vi.spyOn(mutagenService, 'defaultServiceExec').mockImplementation(async (command) => {
      calls.push(command)
      return ok()
    })
    try {
      const result = await probeMutagenDaemon({ dataDirectory: join(root, 'mutagen'), binaryPath: null, platform: 'linux' })
      expect(result).toMatchObject({ running: false, origin: 'none' })
      expect(calls).toContain('ps')
    } finally {
      executor.mockRestore()
    }
  })

  it('reports on-demand origin and none when no matching daemon exists', async () => {
    root = tempRoot()
    const dataDirectory = join(root, 'mutagen')
    const onDemandExec = async (command: string, args: readonly string[]): Promise<Result> => {
      if (command === 'ps' && args[0] === '-axo') {return ok('100 1 /opt/mutagen daemon run\n')}
      if (command === 'sh') {return ok(`MUTAGEN_DATA_DIRECTORY=${dataDirectory}\n`)}
      if (command === 'ps' && args[0] === '-o') {return ok('1\n')}
      return ok('')
    }
    const onDemand = await probeMutagenDaemon({ dataDirectory, binaryPath: null, platform: 'linux', servicePid: 500, exec: onDemandExec })
    expect(onDemand.origin).toBe('on-demand')
    expect(onDemand.pid).toBe(100)

    const none = await probeMutagenDaemon({ dataDirectory, binaryPath: null, platform: 'linux', exec: async (command, args) => command === 'ps' && args[0] === '-axo' ? ok('200 1 /home/user/.mutagen daemon run\n') : ok('GLOBAL=1\n') })
    expect(none).toMatchObject({ running: false, pid: null, origin: 'none' })
  })

  it('prefers a lock holder on darwin but still requires the app-private environment', async () => {
    root = tempRoot()
    const dataDirectory = join(root, 'mutagen')
    const exec = async (command: string, args: readonly string[]): Promise<Result> => {
      if (command === 'lsof') {return ok('777\n')}
      if (command === 'ps' && args[0] === '-E') {return ok(`/opt/mutagen daemon run MUTAGEN_DATA_DIRECTORY=${dataDirectory}\n`)}
      if (command === 'ps' && args[0] === '-o') {return ok('700\n')}
      if (command === '/opt/mutagen') {return ok('Mutagen v0.18.1\nsecond line\n')}
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    }
    const probe = await probeMutagenDaemon({ dataDirectory, binaryPath: '/opt/mutagen', platform: 'darwin', servicePid: 700, exec })
    expect(probe).toMatchObject({ running: true, pid: 777, origin: 'service', version: 'Mutagen v0.18.1' })
  })

  it('accepts a lock holder when ps environment inspection is impossible', async () => {
    root = tempRoot()
    const dataDirectory = join(root, 'mutagen')
    const timeouts: number[] = []
    const exec = async (command: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<Result> => {
      if (options?.timeoutMs !== undefined) {timeouts.push(options.timeoutMs)}
      if (command === 'lsof') {return ok('888\n')}
      if (command === 'ps' && args[0] === '-E') {return { exitCode: 1, stdout: '', stderr: 'ps unavailable' }}
      if (command === 'ps' && args[0] === '-o') {return ok('700\n')}
      if (command === '/opt/mutagen') {return ok('Mutagen v0.18.1\n')}
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    }
    const probe = await probeMutagenDaemon({ dataDirectory, binaryPath: '/opt/mutagen', platform: 'darwin', servicePid: 700, exec })
    expect(probe).toMatchObject({ running: true, pid: 888, origin: 'service' })
    expect(timeouts.length).toBeGreaterThanOrEqual(3)
    expect(timeouts.every((value) => value > 0)).toBe(true)
  })

  it('rejects a lock holder with a successful but wrong environment and bounds every probe exec', async () => {
    root = tempRoot()
    const dataDirectory = join(root, 'mutagen')
    const timeouts: number[] = []
    const exec = async (command: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<Result> => {
      if (options?.timeoutMs !== undefined) {timeouts.push(options.timeoutMs)}
      if (command === 'lsof') {return ok('777\n')}
      if (command === 'ps' && args[0] === '-E') {return ok('/opt/mutagen daemon run MUTAGEN_DATA_DIRECTORY=/tmp/global\n')}
      if (command === 'ps' && args[0] === '-axo') {return ok('100 1 /opt/mutagen daemon run\n')}
      if (command === 'ps' && args[0] === '-o') {return ok('1\n')}
      if (command === '/opt/mutagen') {return ok('Mutagen v0.18.1\n')}
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    }
    const probe = await probeMutagenDaemon({ dataDirectory, binaryPath: '/opt/mutagen', platform: 'darwin', servicePid: 700, exec })
    expect(probe).toMatchObject({ running: false, pid: null, origin: 'none' })
    expect(timeouts.every((value) => value === 2_000)).toBe(true)
  })
})
