import { describe, expect, it, vi } from 'vitest'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import * as terminalAttach from './shell-terminal-attach'
import * as shellReconnect from './shell-reconnect'
import { runDevboxShellWithLoginRelay, type DevboxShellLoginRelaySession } from './shell-login-relay-attach'

describe('shell login relay attach orchestration', () => {
  it('prepares the relay for each attempt, inserts the watcher, and tears it down', async () => {
    const endpoint: SshEndpoint = { host: 'hub.example', port: 22, username: 'sample' }
    const runner: DevboxSshRunner = { command: vi.fn(async () => ''), script: vi.fn(async () => '') }
    const session: DevboxShellLoginRelaySession = {
      prepareAttempt: vi.fn(async () => ({ remoteForwards: ['/tmp/relay.sock:127.0.0.1:4000'], relay: { watcherScript: 'watcher-body' } })),
      stop: vi.fn(async () => undefined)
    }
    const factory = vi.fn(async () => session)
    const interactive = vi.spyOn(terminalAttach, 'runDevboxShellInteractive').mockResolvedValue(0)
    try {
      await runDevboxShellWithLoginRelay({
        profileId: 'roam',
        identity: { id: 1, sessionName: 'devbox-roam-1' },
        remoteCwd: '/home/sample/roam',
        socketName: 'devbox-socket',
        endpoint,
        runner,
        markerInput: {
          profileId: 'roam',
          sessionId: 1,
          sessionName: 'devbox-roam-1',
          host: endpoint.host,
          port: endpoint.port,
          username: endpoint.username,
          program: 'shell',
          cliVersion: '0.5.0'
        },
        terminalMarkers: false,
        reconnect: false,
        loginRelay: factory,
        deviceLabel: 'workstation'
      })
      expect(factory).toHaveBeenCalledWith({ runner, deviceLabel: 'workstation' })
      expect(session.prepareAttempt).toHaveBeenCalledOnce()
      expect(interactive).toHaveBeenCalledWith(
        endpoint,
        expect.stringContaining('watcher-body'),
        expect.anything(),
        { terminalMarkers: false, reconnect: false, remoteForwards: ['/tmp/relay.sock:127.0.0.1:4000'] }
      )
      expect(session.stop).toHaveBeenCalledOnce()
    } finally {
      interactive.mockRestore()
    }
  })

  it('continues without relay when preparation fails', async () => {
    const session: DevboxShellLoginRelaySession = {
      prepareAttempt: vi.fn(async () => { throw new Error('remote unavailable') }),
      stop: vi.fn(async () => undefined)
    }
    const interactive = vi.spyOn(terminalAttach, 'runDevboxShellInteractive').mockResolvedValue(0)
    try {
      await runDevboxShellWithLoginRelay({
        profileId: 'roam',
        identity: { id: 1, sessionName: 'devbox-roam-1' },
        remoteCwd: '/tmp',
        endpoint: { host: 'hub', port: 22, username: 'u' },
        runner: { command: vi.fn(async () => ''), script: vi.fn(async () => '') },
        markerInput: { profileId: 'roam', sessionId: 1, sessionName: 'devbox-roam-1', host: 'hub', port: 22, username: 'u', program: 'shell', cliVersion: '0.5.0' },
        terminalMarkers: false,
        reconnect: false,
        loginRelay: async () => session
      })
      expect(interactive).toHaveBeenCalledWith(expect.anything(), expect.not.stringContaining('watcher-body'), expect.anything(), { terminalMarkers: false, reconnect: false })
      expect(session.stop).toHaveBeenCalledOnce()
    } finally {
      interactive.mockRestore()
    }
  })

  describe('terminal markers across an induced ssh 255', () => {
    const markerInput = { profileId: 'roam', sessionId: 1, sessionName: 'devbox-roam-1', host: 'hub', port: 22, username: 'u', program: 'shell' as const, cliVersion: '0.6.9' }
    const prefix = '\u001b]9998;devbox-terminal;'

    /** Run the real reconnect loop with an injected keyboard/timer and capture stdout markers. */
    async function runWithMarkers(exitCodes: number[], key?: string): Promise<unknown[]> {
      const realLoop = shellReconnect.runDevboxShellWithReconnect
      const writes: string[] = []
      const listeners: ((chunk: string) => void)[] = []
      const stdin = { isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined,
        on: (_event: 'data', listener: (chunk: Buffer | string) => void) => { listeners.push(listener as (chunk: string) => void) },
        off: () => undefined }
      const spies = [
        vi.spyOn(shellReconnect, 'isDevboxShellReconnectEnabled').mockReturnValue(true),
        vi.spyOn(shellReconnect, 'runDevboxShellWithReconnect').mockImplementation((options) => realLoop({
          ...options,
          stdin,
          stderr: { isTTY: true, write: () => true },
          onSignal: () => () => undefined,
          sleep: (_ms, signal) => key === undefined ? Promise.resolve() : new Promise((resolve) => {
            signal.addEventListener('abort', () => { resolve() })
            queueMicrotask(() => { listeners.at(-1)?.(key) })
          })
        })),
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true })
      ]
      const wasTTY = process.stdout.isTTY
      const markersOff = process.env.DEVBOX_TERMINAL_MARKERS
      process.stdout.isTTY = true
      delete process.env.DEVBOX_TERMINAL_MARKERS
      try {
        const codes = [...exitCodes]
        await runDevboxShellWithLoginRelay({
          profileId: 'roam',
          identity: { id: 1, sessionName: 'devbox-roam-1' },
          remoteCwd: '/tmp',
          endpoint: { host: 'hub', port: 22, username: 'u' },
          runner: { command: vi.fn(async () => ''), script: vi.fn(async () => '') },
          markerInput,
          terminalMarkers: true,
          reconnect: true,
          interactive: async () => codes.shift() ?? 0
        })
      } finally {
        process.stdout.isTTY = wasTTY
        if (markersOff !== undefined) {process.env.DEVBOX_TERMINAL_MARKERS = markersOff}
        for (const spy of spies) {spy.mockRestore()}
      }
      return writes.filter((chunk) => chunk.startsWith(prefix)).map((chunk) => JSON.parse(chunk.slice(prefix.length, -1)) as unknown)
    }

    const identity = { v: 1, profileId: 'roam', sessionName: 'devbox-roam-1' }

    it('emits detach{connection-lost} -> state{reconnecting} -> attach, then a clean exit', async () => {
      const markers = await runWithMarkers([255, 0])
      expect(markers.map((marker) => (marker as { event: string }).event)).toEqual(['attach', 'detach', 'state', 'attach', 'detach'])
      expect(markers[1]).toEqual({ ...identity, event: 'detach', reason: 'connection-lost', exitCode: 255 })
      expect(markers[2]).toEqual({ ...identity, event: 'state', state: 'reconnecting', attempt: 1, retryInMs: 1_000 })
      expect(markers[3]).toEqual(markers[0])
      expect(markers[4]).toEqual({ ...identity, event: 'detach', reason: 'exit', exitCode: 0 })
    })

    it('closes an abandoned reconnect with a final exit detach', async () => {
      const markers = await runWithMarkers([255], 'q')
      expect(markers.slice(1)).toEqual([
        { ...identity, event: 'detach', reason: 'connection-lost', exitCode: 255 },
        { ...identity, event: 'state', state: 'reconnecting', attempt: 1, retryInMs: 1_000 },
        { ...identity, event: 'detach', reason: 'exit', exitCode: 255 }
      ])
    })
  })
})

