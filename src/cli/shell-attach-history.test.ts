import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDevboxShellAttachHistory,
  DEVBOX_SHELL_ATTACH_HISTORY_FILE,
  readDevboxTtyPath,
  resolveDevboxResumeTarget,
  resolveDevboxTerminalKey
} from './shell-attach-history'
import type { DevboxShellSession } from './shell-sessions'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devbox-attach-history-'))
  temporaryRoots.push(root)
  return join(root, 'nested', 'state')
}

function session(id: number, sessionName: string, lastUsed = id): DevboxShellSession {
  return {
    id,
    sessionName,
    created: id,
    attached: false,
    lastUsed,
    currentCommand: '',
    currentTitle: '',
    mostRecent: false
  }
}

function withStdinTTY<T>(value: boolean, callback: () => T): T {
  const previous = process.stdin.isTTY
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
  try {
    return callback()
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: previous })
  }
}

describe('resolveDevboxTerminalKey', () => {
  it('prefers a valid Orca handle, then an absolute tty, then unknown', () => {
    let probes = 0
    expect(resolveDevboxTerminalKey({ ORCA_TERMINAL_HANDLE: 'term_abc-123' }, () => {
      probes += 1
      return '/dev/ttys012'
    })).toBe('orca:term_abc-123')
    expect(probes).toBe(0)
    expect(resolveDevboxTerminalKey({ ORCA_TERMINAL_HANDLE: 'term/invalid' }, () => '/dev/ttys012')).toBe('tty:/dev/ttys012')
    expect(resolveDevboxTerminalKey({ ORCA_TERMINAL_HANDLE: 'bad space' }, () => undefined)).toBe('unknown')
    expect(resolveDevboxTerminalKey({}, () => 'relative/tty')).toBe('unknown')
  })
})

describe('readDevboxTtyPath', () => {
  it('does not spawn when stdin is not a tty', () => {
    withStdinTTY(false, () => {
      let spawned = false
      expect(readDevboxTtyPath(() => {
        spawned = true
        return { stdout: '/dev/ttys001' }
      })).toBeUndefined()
      expect(spawned).toBe(false)
    })
  })

  it('returns undefined when the injected tty probe fails', () => {
    withStdinTTY(true, () => {
      expect(readDevboxTtyPath(() => { throw new Error('tty unavailable') })).toBeUndefined()
      expect(readDevboxTtyPath(() => ({ status: 1, stdout: '/dev/ttys001' }))).toBeUndefined()
    })
  })

  it('trims successful injected tty output', () => {
    withStdinTTY(true, () => {
      expect(readDevboxTtyPath(() => ({ status: 0, stdout: '  /dev/ttys001\n' }))).toBe('/dev/ttys001')
    })
  })
})

describe('DevboxShellAttachHistory', () => {
  it('records and round-trips terminal and profile lookups', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:term_a', now: () => 123 })
    await history.record({ profileId: 'roam', sessionName: 'devbox-roam-1', id: 1, name: 'one' })
    const expected = { profileId: 'roam', sessionName: 'devbox-roam-1', id: 1, name: 'one', terminalKey: 'orca:term_a', attachedAt: 123 }
    expect(await history.lastForTerminal('roam')).toEqual(expected)
    const otherTerminal = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'tty:/dev/ttys002' })
    expect(await otherTerminal.lastForTerminal('roam')).toBeUndefined()
    expect(await otherTerminal.lastForProfile('roam')).toEqual(expected)
  })

  it('deduplicates re-attaches, moves them to the end, and bounds entries', async () => {
    const root = await stateRoot()
    let timestamp = 0
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:term_a', maxEntries: 2, now: () => ++timestamp })
    await history.record({ profileId: 'p', sessionName: 'devbox-p-1', id: 1 })
    await history.record({ profileId: 'p', sessionName: 'devbox-p-2', id: 2 })
    await history.record({ profileId: 'p', sessionName: 'devbox-p-1', id: 1 })
    await history.record({ profileId: 'p', sessionName: 'devbox-p-3', id: 3 })
    const document = JSON.parse(await readFile(join(root, DEVBOX_SHELL_ATTACH_HISTORY_FILE), 'utf8')) as { entries: unknown[] }
    expect(document.entries).toHaveLength(2)
    expect(document.entries.map((entry) => (entry as { sessionName: string }).sessionName)).toEqual(['devbox-p-1', 'devbox-p-3'])
    expect((document.entries[0] as { attachedAt: number }).attachedAt).toBe(3)
  })

  it('treats missing, corrupt, and unknown-version files as empty', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'unknown' })
    expect(await history.lastForProfile('p')).toBeUndefined()
    await mkdir(root, { recursive: true })
    const path = join(root, DEVBOX_SHELL_ATTACH_HISTORY_FILE)
    await writeFile(path, '{not json', 'utf8')
    expect(await history.lastForProfile('p')).toBeUndefined()
    await writeFile(path, JSON.stringify({ version: 99, entries: [] }), 'utf8')
    expect(await history.lastForProfile('p')).toBeUndefined()
  })

  it('creates a private state directory and private history file', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'unknown' })
    await history.record({ profileId: 'p', sessionName: 'devbox-p-1', id: 1 })
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, DEVBOX_SHELL_ATTACH_HISTORY_FILE))).mode & 0o777).toBe(0o600)
  })
})

describe('resolveDevboxResumeTarget', () => {
  it('prefers this terminal record over a newer profile record', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:here', now: () => 1 })
    const other = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:other', now: () => 2 })
    await history.record({ profileId: 'p', sessionName: 'devbox-p-1', id: 1 })
    await other.record({ profileId: 'p', sessionName: 'devbox-p-2', id: 2 })
    await expect(resolveDevboxResumeTarget(history, 'p', [session(1, 'devbox-p-1'), session(2, 'devbox-p-2')])).resolves.toEqual({
      session: session(1, 'devbox-p-1'),
      source: 'terminal'
    })
  })

  it('skips stale terminal and profile records before falling back to most recent', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:here', now: () => 1 })
    const other = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:other', now: () => 2 })
    await history.record({ profileId: 'p', sessionName: 'gone-terminal', id: 9 })
    await other.record({ profileId: 'p', sessionName: 'gone-profile', id: 8 })
    const sessions = [session(1, 'devbox-p-1', 10), session(2, 'devbox-p-2', 20)]
    await expect(resolveDevboxResumeTarget(history, 'p', sessions)).resolves.toEqual({ session: sessions[1], source: 'most-recent' })
  })

  it('uses a valid profile record after a stale terminal record', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:here', now: () => 1 })
    const other = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'orca:other', now: () => 2 })
    await history.record({ profileId: 'p', sessionName: 'gone-terminal', id: 9 })
    await other.record({ profileId: 'p', sessionName: 'devbox-p-3', id: 3 })
    const target = session(3, 'devbox-p-3')
    await expect(resolveDevboxResumeTarget(history, 'p', [target])).resolves.toEqual({ session: target, source: 'profile' })
  })

  it('returns undefined when there are no sessions', async () => {
    const root = await stateRoot()
    const history = createDevboxShellAttachHistory({ stateRoot: root, terminalKey: 'unknown' })
    await expect(resolveDevboxResumeTarget(history, 'p', [])).resolves.toBeUndefined()
  })
})
