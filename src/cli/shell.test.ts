import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import { runDevboxShellInteractive } from './shell-terminal-attach'
import * as shellTerminalAttach from './shell-terminal-attach'
import * as shellReconnect from './shell-reconnect'
import type { DevboxShellAttachHistory } from './shell-attach-history'
import {
  allocateDevboxShellId,
  assertDevboxShellSessionName,
  attachDevboxShell,
  buildDevboxShellAttachCommand,
  buildDevboxShellCredentialPrepareScript,
  devboxShellSocketName,
  buildDevboxShellKillCommand,
  buildDevboxShellKillIfUnattachedCommand,
  buildDevboxShellListCommand,
  buildDevboxShellSessionName,
  DEVBOX_SHELL_INSTALL_COMMAND,
  DEVBOX_DARWIN_SHELL_INSTALL_COMMAND,
  ensureDevboxTmux,
  ensureDevboxShellDirectory,
  listDevboxShellSessions,
  parseDevboxLegacyShellSessionName,
  parseDevboxShellSessionLine,
  parseDevboxShellSessionName,
  sanitizeDevboxShellComponent,
  selectMostRecentDevboxShellSession,
  resolveDevboxShellAttachSocket,
  resolveDevboxShellCwd,
  killAllDevboxShells,
  killDevboxShell,
  killUnattachedDevboxShells,
  resumeDevboxShell
} from './shell'
import { killCurrentDevboxShellLocally } from './shell-current'

function runnerFor(
  implementation: (command: string) => Promise<string>
): { runner: DevboxSshRunner; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runner: {
      command: vi.fn(async (command: string) => {
        calls.push(command)
        return implementation(command)
      }),
      script: vi.fn(async () => '')
    }
  }
}

describe('devbox shell session names and remote argv', () => {
  it('encodes ids and sanitized friendly names, then round-trips them strictly', () => {
    expect(sanitizeDevboxShellComponent(' worker / one ')).toBe('worker-one')
    const sessionName = buildDevboxShellSessionName('roam', 3, ' worker / one ')
    expect(sessionName).toBe('devbox-roam-3-worker-one')
    expect(parseDevboxShellSessionName('roam', sessionName)).toEqual({
      id: 3,
      name: 'worker-one',
      sessionName
    })
    const socket = devboxShellSocketName('roam')
    expect(socket).toBe('devbox-01ff033d051e')
    const attach = buildDevboxShellAttachCommand(sessionName, '/home/sample/roam', 'roam', socket)
    expect(attach).toContain(`socket='${socket}'`)
    expect(attach).toContain(`tmux -f /dev/null -L "$socket" new-session -d -s "$session" -c "$cwd"`)
    expect(attach).toContain('tmux -f /dev/null -L "$socket" set-option -g extended-keys on')
    expect(attach).toContain('tmux -f /dev/null -L "$socket" set-option -s extended-keys on')
    expect(attach).toContain('tmux -f /dev/null -L "$socket" set-option -g mouse on')
    expect(attach).toContain('tmux -f /dev/null -L "$socket" set-option -g history-limit 100000')
    expect(attach).toContain('set-option -g set-clipboard on')
    expect(attach).not.toContain("terminal-features 'clipboard'")
    expect(attach).toContain('tmux -f /dev/null -L "$socket" set-option -su terminal-features 2>/dev/null || true')
    expect(attach).toContain(`tmux -f /dev/null -L "$socket" set-option -sa terminal-features 'xterm*:clipboard:ccolour:cstyle:focus:title' 2>/dev/null || true`)
    expect(attach).toContain('tmux -f /dev/null -L "$socket" set-option -g set-titles on')
    expect(attach).toContain(`tmux -f /dev/null -L "$socket" set-option -g set-titles-string '#{pane_title}'`)
    expect(attach).not.toContain('allow-passthrough')
    expect(attach).not.toContain('extended-keys-format')
    expect(attach).toContain("bind-key -n WheelUpPane if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}'")
    expect(attach).toContain("bind-key -n MouseDrag1Pane if-shell")
    expect(attach).toContain("bind-key -T copy-mode WheelUpPane select-pane -t = '\\;'")
    expect(attach).toContain('MouseDragEnd1Pane send-keys -X copy-selection-and-cancel')
    expect(attach).toContain('status-left')
    expect(attach).toContain('DEVBOX')
    expect(attach).toContain('#{pane_current_command}')
    expect(attach).toContain('#{=-40:pane_current_path}')
    expect(attach).toContain('#{?client_prefix')
    expect(attach).toContain('%H:%M')
    expect(attach).not.toContain('MouseDown2Pane')
    expect(attach).not.toContain('bind-key -n C-')
    const attachBootstrap = attach.indexOf('new-session -d -s "$bootstrap"')
    const attachDefaults = attach.indexOf('set-option -g history-limit 100000', attachBootstrap)
    const attachTarget = attach.indexOf('new-session -d -s "$session"', attachBootstrap)
    expect(attachBootstrap).toBeLessThan(attachDefaults)
    expect(attachDefaults).toBeLessThan(attachTarget)
    expect(() => execFileSync('bash', ['-n', '-c', attach])).not.toThrow()
    const relayAttach = buildDevboxShellAttachCommand(sessionName, '/home/sample/roam', 'roam', socket, { watcherScript: 'echo watcher' })
    expect(relayAttach.indexOf('echo watcher')).toBeLessThan(relayAttach.indexOf('exec tmux'))
    expect(() => execFileSync('bash', ['-n', '-c', relayAttach])).not.toThrow()
    const credentialCommand = buildDevboxShellAttachCommand(sessionName, '/home/sample/roam', 'roam', socket)
    expect(credentialCommand).toContain(`devbox_env_path='\\''/dev/shm/devbox-roam.env'\\''`)
    expect(credentialCommand).toContain("getconf DARWIN_USER_TEMP_DIR")
    expect(credentialCommand).toContain('set -a; . "$devbox_env_path" 2>/dev/null; set +a; exec $SHELL')
    expect(credentialCommand).not.toContain('synthetic-credential-value')
    const prepare = buildDevboxShellCredentialPrepareScript('roam', sessionName, '/home/sample/roam', socket)
    expect(prepare).toContain('set-environment -t')
    // Why: `tmux -C` with no attach target mints a session per invocation; the
    // credential prepare path must never reintroduce it (leaked 293 orphans).
    expect(prepare).not.toContain('tmux -C')
    expect(prepare).toContain('tmux -f /dev/null -L "$socket" set-option -g extended-keys on')
    expect(prepare).toContain('tmux -f /dev/null -L "$socket" set-option -g mouse on')
    expect(prepare).toContain('tmux -f /dev/null -L "$socket" set-option -g history-limit 100000')
    expect(() => execFileSync('bash', ['-n', '-c', prepare])).not.toThrow()
    const prepareBootstrap = prepare.indexOf('new-session -d -s "$bootstrap"')
    const prepareDefaults = prepare.indexOf('set-option -g history-limit 100000', prepareBootstrap)
    const prepareTarget = prepare.indexOf('new-session -d -s "$session"', prepareBootstrap)
    expect(prepareBootstrap).toBeLessThan(prepareDefaults)
    expect(prepareDefaults).toBeLessThan(prepareTarget)
    expect(buildDevboxShellListCommand()).toContain("tmux list-sessions -F '#{session_name}\t")
    expect(buildDevboxShellListCommand(socket)).toContain(`tmux -f /dev/null -L '${socket}' list-sessions`)
    expect(buildDevboxShellKillCommand(sessionName)).toBe(
      "tmux kill-session -t 'devbox-roam-3-worker-one'"
    )
    expect(buildDevboxShellKillCommand(sessionName, socket, true)).toBe(
      `tmux -f /dev/null -L '${socket}' kill-session -t 'devbox-roam-3-worker-one' 2>/dev/null || true`
    )
    const killIfUnattached = buildDevboxShellKillIfUnattachedCommand(sessionName)
    expect(killIfUnattached).toContain('tmux if-shell -F')
    expect(killIfUnattached).toContain('session_attached')
    expect(killIfUnattached).toContain('kill-session -t')
    expect(killIfUnattached).toContain('display-message -p -t')
    expect(killIfUnattached).toContain('#{session_name}')
    expect(killIfUnattached.indexOf('display-message -p')).toBeLessThan(killIfUnattached.indexOf('kill-session -t'))
    expect(() => execFileSync('bash', ['-n', '-c', killIfUnattached])).not.toThrow()
    expect(killIfUnattached).toContain('devbox-roam-3-worker-one')
    expect(killIfUnattached).not.toContain('kill-server')
    expect(killIfUnattached).not.toContain('*')
  })

  it('preserves the legacy default socket when attaching an existing session', () => {
    expect(resolveDevboxShellAttachSocket('roam', undefined)).toBe(devboxShellSocketName('roam'))
    expect(resolveDevboxShellAttachSocket('roam', { socketName: undefined })).toBeUndefined()
    expect(resolveDevboxShellAttachSocket('roam', { socketName: 'private-socket' })).toBe('private-socket')
  })

  it('resolves cwd in override, profile, then root order and validates absolute paths', () => {
    expect(resolveDevboxShellCwd('/remote/root', '/profile/default', '/one-off')).toBe('/one-off')
    expect(resolveDevboxShellCwd('/remote/root', '/profile/default')).toBe('/profile/default')
    expect(resolveDevboxShellCwd('/remote/root')).toBe('/remote/root')
    expect(() => resolveDevboxShellCwd('/remote/root', 'relative')).toThrow('absolute remote path')
  })

  it('refuses foreign or malformed names on ownership checks', () => {
    expect(() => assertDevboxShellSessionName('roam', 'other-main')).toThrow('outside the Devbox prefix')
    expect(() => assertDevboxShellSessionName('roam', 'devbox-roam-foo/bar')).toThrow(
      'outside the Devbox naming policy'
    )
    expect(parseDevboxShellSessionName('roam', 'devbox-roam-1-')).toBeUndefined()
    expect(parseDevboxShellSessionName('roam', 'devbox-other-1')).toBeUndefined()
    expect(parseDevboxLegacyShellSessionName('roam', 'devbox-roam-main')).toEqual({
      name: 'main',
      sessionName: 'devbox-roam-main'
    })
    expect(parseDevboxLegacyShellSessionName('roam', 'devbox-roam-1')).toBeUndefined()
    expect(parseDevboxLegacyShellSessionName('roam', 'devbox-roam-bad/name')).toBeUndefined()
  })

  it('allocates the lowest free positive id and reuses ids after removal', () => {
    expect(allocateDevboxShellId([{ id: 2 }, { id: 4 }])).toBe(1)
    expect(allocateDevboxShellId([{ id: 1 }, { id: 3 }, { id: 4 }])).toBe(2)
    expect(allocateDevboxShellId([])).toBe(1)
  })

  it('selects MRU from tmux activity, with creation and id tie breaks', () => {
    const sessions = [
      parseDevboxShellSessionLine('roam', 'devbox-roam-1\t1710000000\t0\t1710000010\tbash\tone')!,
      parseDevboxShellSessionLine('roam', 'devbox-roam-2-agents\t1710000001\t1\t1710000020\tpython\ttwo')!,
      parseDevboxShellSessionLine('roam', 'devbox-roam-3\t1710000002\t0\t1710000005\tzsh\tthree')!
    ]
    expect(selectMostRecentDevboxShellSession(sessions)?.id).toBe(2)
  })

  it('fails closed for malformed attachment metadata', () => {
    for (const attachment of ['1', '2', 'unknown', '']) {
      const session = parseDevboxShellSessionLine(
        'roam',
        `devbox-roam-1\t1710000000\t${attachment}\t1710000001\tbash\tunknown`
      )
      expect(session?.attached).toBe(true)
    }
    expect(parseDevboxShellSessionLine(
      'roam',
      'devbox-roam-1\t1710000000\t0\t1710000001\tbash\tdetached'
    )?.attached).toBe(false)
  })
})

describe('devbox shell tmux prerequisite and listing', () => {
  it('installs missing tmux through Homebrew on Darwin without sudo', async () => {
    const calls: string[] = []
    const runner: DevboxSshRunner = {
      command: vi.fn(async (command) => {
        calls.push(command)
        if (command === 'command -v tmux') {return calls.length === 1 ? '' : '/opt/homebrew/bin/tmux'}
        if (command === 'uname -s') {return 'Darwin\n'}
        return ''
      }),
      script: vi.fn(async () => '')
    }
    await ensureDevboxTmux(runner)
    expect(calls).toEqual(['command -v tmux', 'uname -s', DEVBOX_DARWIN_SHELL_INSTALL_COMMAND, 'command -v tmux'])
  })

  it('installs tmux through non-interactive sudo when it is missing', async () => {
    let checked = false
    const output: string[] = []
    const { runner, calls } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {
        if (!checked) {
          checked = true
          throw new Error('not found')
        }
        return '/usr/bin/tmux\n'
      }
      return ''
    })
    await ensureDevboxTmux(runner, (line) => output.push(line))
    expect(calls).toEqual(['command -v tmux', 'uname -s', 'sudo -n true', DEVBOX_SHELL_INSTALL_COMMAND, 'command -v tmux'])
    expect(output[0]).toContain(DEVBOX_SHELL_INSTALL_COMMAND)
  })

  it('validates that a selected cwd exists remotely and is a directory', async () => {
    const { runner, calls } = runnerFor(async () => '')
    await ensureDevboxShellDirectory(runner, '/home/sample')
    expect(calls).toEqual(["test -d '/home/sample'"])
    const missing = runnerFor(async () => { throw new Error('missing') })
    await expect(ensureDevboxShellDirectory(missing.runner, '/missing')).rejects.toThrow('does not exist remotely')
  })

  it('returns exact remediation when passwordless sudo is unavailable', async () => {
    const { runner } = runnerFor(async (command) => {
      if (command === 'command -v tmux' || command === 'sudo -n true') {
        throw new Error('missing')
      }
      return ''
    })
    await expect(ensureDevboxTmux(runner)).rejects.toThrow(
      `Install it with: ${DEVBOX_SHELL_INSTALL_COMMAND}`
    )
  })

  it('lists only profile-owned sessions with ids, names, activity, and pane metadata', async () => {
    const { runner, calls } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
      return [
        'devbox-roam-1\t1710000000\t1\t1710000010\tbash\tmain',
        'devbox-roam-2-worker\t1710000001\t0\t1710000020\tphi\tworker',
        'devbox-other-9\t1710000002\t0\t1710000030\tzsh\tforeign',
        'devbox-roam-malformed\t1710000003\t0\t1710000040\tbad\tbad',
        'devbox-roam-old-shell\t1710000004\t0\t1710000050\tsh\tlegacy',
        'foreign-roam-shell\t1710000005\t0\t1710000060\tsh\tforeign',
        ''
      ].join('\n')
    })
    await expect(listDevboxShellSessions('roam', runner)).resolves.toEqual({
      profileId: 'roam',
      mostRecentId: 2,
      sessions: [
        {
          id: 1,
          sessionName: 'devbox-roam-1',
          created: 1710000000,
          attached: true,
          lastUsed: 1710000010,
          currentCommand: 'bash',
          currentTitle: 'main',
          mostRecent: false
        },
        {
          id: 2,
          name: 'worker',
          sessionName: 'devbox-roam-2-worker',
          created: 1710000001,
          attached: false,
          lastUsed: 1710000020,
          currentCommand: 'phi',
          currentTitle: 'worker',
          mostRecent: true
        }
      ]
    })
    expect(calls[1]).toContain("tmux -f /dev/null -L 'devbox-01ff033d051e' list-sessions")
    expect(calls[2]).toContain("tmux list-sessions -F")
  })

  it('removes canonical and legacy sessions from their originating sockets without touching foreign names', async () => {
    const calls: string[] = []
    const privateOutput = 'devbox-roam-1-worker\t1710000000\t0\t1710000001\tbash\tworker\n'
    const defaultOutput = 'devbox-roam-1-worker\t1710000000\t0\t1710000001\tbash\tduplicate\ndevbox-roam-old-shell\t1710000000\t0\t1710000001\tsh\tlegacy\nforeign-1\t1710000000\t0\t1710000001\tsh\tforeign\n'
    const runner: DevboxSshRunner = {
      command: vi.fn(async (command: string) => {
        calls.push(command)
        if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
        if (command.includes("-L 'devbox-")) {return privateOutput}
        return defaultOutput
      }),
      script: vi.fn(async () => '')
    }

    await expect(killDevboxShell('roam', 'old-shell', runner)).resolves.toMatchObject({
      profileId: 'roam',
      name: 'old-shell',
      sessionName: 'devbox-roam-old-shell',
      killed: true
    })
    expect(calls).toContain("tmux kill-session -t 'devbox-roam-old-shell' 2>/dev/null || true")
    expect(calls.some((call) => call.includes('foreign-1'))).toBe(false)

    calls.length = 0
    await expect(killAllDevboxShells('roam', runner)).resolves.toMatchObject({
      count: 3,
      sessions: ['devbox-roam-1-worker', 'devbox-roam-1-worker', 'devbox-roam-old-shell']
    })
    expect(calls.filter((call) => call.includes('kill-session'))).toHaveLength(3)
    expect(calls.join('\n')).not.toContain('kill-server')
    expect(calls.join('\n')).not.toContain('devbox-roam-*')
  })

  it('lists existing sessions when an attach target is unknown', async () => {
    const { runner } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
      return 'devbox-roam-1\t1710000000\t0\t1710000001\tbash\tmain\n'
    })
    await expect(killDevboxShell('roam', 'missing', runner)).rejects.toThrow(
      "No Devbox shell session matches 'missing'. Existing sessions: 1"
    )
  })

  it('targets the exact tmux session name when several sessions share an id', async () => {
    const { runner, calls } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
      if (command.startsWith('tmux list-sessions')) {
        return ['d1', 'd2', 'd3', 'd4'].map((name) => `devbox-devbox-2-${name}\t1710000000\t0\t1710000001\tbash\t${name}`).join('\n')
      }
      return ''
    })
    await expect(killDevboxShell('devbox', 'devbox-devbox-2-d3', runner)).resolves.toMatchObject({ id: 2, name: 'd3', sessionName: 'devbox-devbox-2-d3' })
    expect(calls.filter((call) => call.includes('kill-session')).join('\n')).toContain('devbox-devbox-2-d3')
  })

  it('kills only detached owned sessions and counts server-side evidence', async () => {
    const { runner, calls } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
      if (command.startsWith('tmux list-sessions')) {
        return [
          'devbox-roam-1\t1710000000\t1\t1710000010\tbash\tattached',
          'devbox-roam-2-worker\t1710000001\t0\t1710000020\tphi\tdetached',
          'devbox-roam-3-idle\t1710000002\t0\t1710000030\tzsh\tidle',
          'devbox-roam-4-unknown\t1710000003\tunknown\t1710000040\tzsh\tunknown',
          'devbox-other-9\t1710000004\t0\t1710000050\tzsh\tforeign'
        ].join('\n')
      }
      if (command.includes("'devbox-roam-2-worker'")) {return ''}
      if (command.includes("'devbox-roam-3-idle'")) {return 'devbox-roam-3-idle\n'}
      return ''
    })

    await expect(killUnattachedDevboxShells('roam', runner)).resolves.toEqual({
      profileId: 'roam',
      count: 1,
      sessions: ['devbox-roam-3-idle'],
      killed: true
    })
    expect(calls.filter((command) => command.includes('if-shell -F'))).toHaveLength(2)
    expect(calls.filter((command) => command.includes('kill-session -t'))).toHaveLength(2)
    const guardedKills = calls.filter((command) => command.includes('if-shell -F'))
    expect(guardedKills.some((command) => command.includes('devbox-roam-1'))).toBe(false)
    expect(guardedKills.some((command) => command.includes('devbox-roam-4-unknown'))).toBe(false)
    expect(guardedKills.some((command) => command.includes('devbox-other-9'))).toBe(false)
    expect(calls.every((command) => !command.includes('kill-server'))).toBe(true)
  })

  it('counts evidence before killing a sole detached last session', async () => {
    const { runner, calls } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
      if (command.startsWith('tmux list-sessions')) {
        return 'devbox-roam-1\t1710000000\t0\t1710000001\tbash\tlast\n'
      }
      return 'devbox-roam-1\n'
    })
    await expect(killUnattachedDevboxShells('roam', runner)).resolves.toEqual({
      profileId: 'roam',
      count: 1,
      sessions: ['devbox-roam-1'],
      killed: true
    })
    const killCommand = calls.find((command) => command.includes('if-shell -F'))
    expect(killCommand).toBeDefined()
    expect(killCommand!.indexOf('display-message -p')).toBeLessThan(killCommand!.indexOf('kill-session -t'))
  })

  it('does not count a detached candidate when the server observes an attached race', async () => {
    const { runner, calls } = runnerFor(async (command) => {
      if (command === 'command -v tmux') {return '/usr/bin/tmux\n'}
      if (command.startsWith('tmux list-sessions')) {
        return 'devbox-roam-1\t1710000000\t0\t1710000001\tbash\trace\n'
      }
      // An empty response models if-shell skipping its branch after a client
      // attaches between the inventory and the server-side condition check.
      return ''
    })
    await expect(killUnattachedDevboxShells('roam', runner)).resolves.toEqual({
      profileId: 'roam',
      count: 0,
      sessions: [],
      killed: true
    })
    expect(calls.filter((command) => command.includes('if-shell -F'))).toHaveLength(1)
    expect(calls.every((command) => !command.startsWith('tmux kill-session'))).toBe(true)
  })

  it('resolves rm this locally before any remote command and kills the exact owned session', () => {
    const env = { TMUX: 'socket,1,0', TMUX_PANE: '%7' }
    const displayMessage = vi.fn((_args: readonly string[], _env: NodeJS.ProcessEnv) => 'devbox-roam-4\n')
    const exec = vi.fn()
    expect(killCurrentDevboxShellLocally(env, exec, 'roam', displayMessage)).toMatchObject({
      profileId: 'roam', sessionName: 'devbox-roam-4', killed: true
    })
    expect(exec).toHaveBeenCalledWith('tmux', ['kill-session', '-t', 'devbox-roam-4'], expect.objectContaining({ env }))
  })

  it('rejects rm this outside tmux, on lookup failure, or for a foreign profile before SSH', () => {
    expect(() => killCurrentDevboxShellLocally({})).toThrow('TMUX and TMUX_PANE')
    const lookup = vi.fn(() => { throw new Error('tmux unavailable') })
    expect(() => killCurrentDevboxShellLocally({ TMUX: 'socket,1,0', TMUX_PANE: '%7' }, vi.fn(), 'roam', lookup)).toThrow('could not resolve')
    expect(() => killCurrentDevboxShellLocally({ TMUX: 'socket,1,0', TMUX_PANE: '%7' }, vi.fn(), 'roam', () => 'devbox-other-1\n')).toThrow('not owned by Devbox')
  })
})


describe('shell reconnect and attach history integration', () => {
  const endpoint: SshEndpoint = { host: 'host.example', port: 22, username: 'sample' }

  function history(overrides: Partial<DevboxShellAttachHistory> = {}): DevboxShellAttachHistory {
    return {
      terminalKey: 'orca:term_test',
      record: vi.fn(async () => undefined),
      lastForTerminal: vi.fn(async () => undefined),
      lastForProfile: vi.fn(async () => undefined),
      ...overrides
    }
  }

  it('records the resolved attach identity before the interactive attempt', async () => {
    const { runner } = runnerFor(async (command) => command === 'command -v tmux' ? '/usr/bin/tmux\n' : '')
    const attachHistory = history()
    const run = vi.spyOn(shellTerminalAttach, 'runDevboxShellInteractive').mockResolvedValue(0)
    await attachDevboxShell('roam', undefined, '/remote', undefined, runner, endpoint, undefined, undefined, false, { history: attachHistory, reconnect: false })
    expect(attachHistory.record).toHaveBeenCalledWith({ profileId: 'roam', sessionName: 'devbox-roam-1', id: 1 })
    expect(run).toHaveBeenCalledOnce()
    run.mockRestore()
  })

  it('adds reconnectAttempts only after a retrying interactive outcome', async () => {
    const { runner } = runnerFor(async (command) => command === 'command -v tmux' ? '/usr/bin/tmux\n' : '')
    const attachHistory = history()
    const interactive = vi.spyOn(shellTerminalAttach, 'runDevboxShellInteractive').mockResolvedValue(0)
    const reconnect = vi.spyOn(shellReconnect, 'runDevboxShellWithReconnect').mockResolvedValue({ exitCode: 0, attempts: 3, reconnected: true, abandoned: false })
    const result = await attachDevboxShell('roam', undefined, '/remote', undefined, runner, endpoint, undefined, undefined, true, { history: attachHistory })
    expect(result).toMatchObject({ exitCode: 0, reconnectAttempts: 2 })
    expect(reconnect).toHaveBeenCalledOnce()
    interactive.mockRestore()
    reconnect.mockRestore()
  })

  it('resumes the profile record and explains why this terminal was not recorded', async () => {
    const { runner } = runnerFor(async (command) => command === 'command -v tmux'
      ? '/usr/bin/tmux\n'
      : 'devbox-roam-3-hypervansys\t1710000000\t0\t1710000010\tbash\thypervansys\n')
    const attachHistory = history({
      lastForProfile: vi.fn(async () => ({ profileId: 'roam', sessionName: 'devbox-roam-3-hypervansys', id: 3, name: 'hypervansys', terminalKey: 'orca:other', attachedAt: 1 }))
    })
    const run = vi.spyOn(shellTerminalAttach, 'runDevboxShellInteractive').mockResolvedValue(0)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await resumeDevboxShell('roam', '/remote', undefined, runner, endpoint, attachHistory, undefined, undefined, false, { reconnect: false })
    expect(stderr).toHaveBeenCalledWith('devbox: resuming most recent shell #3 (hypervansys) — last used from this machine\n')
    expect(run).toHaveBeenCalledWith(endpoint, expect.stringContaining("session='devbox-roam-3-hypervansys'"), expect.anything(), { terminalMarkers: false, reconnect: false })
    run.mockRestore()
    stderr.mockRestore()
  })
})

describe('terminal host integration marker shell lifecycle', () => {
  const endpoint: SshEndpoint = { host: 'host.example', port: 22, username: 'sample' }
  const attachInput = {
    profileId: 'roam',
    sessionId: 1,
    sessionName: 'devbox-roam-1',
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    program: 'shell' as const,
    cliVersion: '0.2.15'
  }

  it('writes attach before and detach after the interactive SSH child', async () => {
    const writes: string[] = []
    const stream = { isTTY: true, write: vi.fn((chunk: string) => { writes.push(chunk); return true }) }
    const run = vi.fn(async () => 17)
    await expect(runDevboxShellInteractive(endpoint, 'exec tmux attach', attachInput, { stream, env: {}, run })).resolves.toBe(17)
    expect(run).toHaveBeenCalledOnce()
    expect(writes).toEqual([
      '\u001b]9998;devbox-terminal;{"v":1,"event":"attach","profileId":"roam","sessionId":1,"sessionName":"devbox-roam-1","host":"host.example","port":22,"username":"sample","program":"shell","cliVersion":"0.2.15"}\u0007',
      '\u001b]9998;devbox-terminal;{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-1","reason":"error","exitCode":17}\u0007'
    ])
  })

  it.each([
    [0, false, '"reason":"exit","exitCode":0'],
    [0, true, '"reason":"exit","exitCode":0'],
    [255, true, '"reason":"connection-lost","exitCode":255'],
    [255, false, '"reason":"error","exitCode":255'],
    [130, true, '"reason":"error","exitCode":130']
  ])('says why the attach ended: exit %i with reconnect=%s', async (exitCode, reconnect, expected) => {
    const writes: string[] = []
    const stream = { isTTY: true, write: vi.fn((chunk: string) => { writes.push(chunk); return true }) }
    await runDevboxShellInteractive(endpoint, 'exec tmux attach', attachInput, { stream, env: {}, reconnect, run: vi.fn(async () => exitCode) })
    expect(writes[1]).toBe(`\u001b]9998;devbox-terminal;{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-1",${expected}}\u0007`)
  })

  it('writes detach even when the interactive SSH runner rejects', async () => {
    const writes: string[] = []
    const stream = { isTTY: true, write: vi.fn((chunk: string) => { writes.push(chunk); return true }) }
    const run = vi.fn(async () => { throw new Error('spawn failed') })
    await expect(runDevboxShellInteractive(endpoint, 'exec tmux attach', attachInput, { stream, env: {}, run })).rejects.toThrow('spawn failed')
    expect(writes[1]).toBe('\u001b]9998;devbox-terminal;{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-1","reason":"error"}\u0007')
  })

  it('passes remote forwards through the interactive SSH seam', async () => {
    const run = vi.fn(async (_endpoint: SshEndpoint, _command: string, options?: { remoteForwards?: readonly string[] }) => {
      expect(options?.remoteForwards).toEqual(['/tmp/relay.sock:127.0.0.1:4000'])
      return 0
    })
    await runDevboxShellInteractive(endpoint, 'exec tmux attach', attachInput, {
      stream: { isTTY: false, write: vi.fn(() => true) },
      terminalMarkers: false,
      remoteForwards: ['/tmp/relay.sock:127.0.0.1:4000'],
      run
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('suppresses both frames when the caller is rendering JSON', async () => {
    const writes: string[] = []
    const stream = { isTTY: true, write: vi.fn((chunk: string) => { writes.push(chunk); return true }) }
    await runDevboxShellInteractive(endpoint, 'exec tmux attach', attachInput, {
      stream,
      env: {},
      terminalMarkers: false,
      run: vi.fn(async () => 0)
    })
    expect(writes).toEqual([])
  })
})
