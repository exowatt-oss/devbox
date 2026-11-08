import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DevboxSshRunner, SshEndpoint } from '../shared/ssh-runner-types'
import * as shellTerminalAttach from './shell-terminal-attach'
import type { DevboxShellAttachHistory } from './shell-attach-history'
import { attachDevboxShell, buildDevboxShellAttachCommand, devboxShellSocketName, newDevboxShell, resumeDevboxShell } from './shell'

const endpoint: SshEndpoint = { host: 'host.example', port: 22, username: 'sample' }
const socket = devboxShellSocketName('roam')
const tmux = 'tmux -f /dev/null -L "$socket"'

function runner(sessions = ''): DevboxSshRunner {
  return {
    command: vi.fn(async (command: string) => command === 'command -v tmux' ? '/usr/bin/tmux\n' : sessions),
    script: vi.fn(async () => '')
  }
}

function history(): DevboxShellAttachHistory {
  return {
    terminalKey: 'orca:term_test',
    record: vi.fn(async () => undefined),
    lastForTerminal: vi.fn(async () => undefined),
    lastForProfile: vi.fn(async () => undefined)
  }
}

describe('devbox shell new --run', () => {
  it('types the escaped command once, guarded by a marker set before send-keys, before attaching', () => {
    const script = buildDevboxShellAttachCommand('devbox-roam-2-review', '/srv', 'roam', socket, undefined, `opus --session 'abc'; echo $HOME`)
    expect(script).toContain(`run='opus --session '\\''abc'\\''; echo $HOME'`)
    expect(script).toContain(`if [ -z "$(${tmux} show-options -qv -t "$session" @devbox-run-sent 2>/dev/null)" ]; then`)
    const marker = script.indexOf(`${tmux} set-option -q -t "$session" @devbox-run-sent 1`)
    const typed = script.indexOf(`${tmux} send-keys -t "$session" -l -- "$run"`)
    const enter = script.indexOf(`${tmux} send-keys -t "$session" Enter`)
    const ensure = script.lastIndexOf('new-session -d -s "$session"')
    const attach = script.indexOf('exec tmux')
    expect(ensure).toBeGreaterThan(0)
    expect(marker).toBeGreaterThan(ensure)
    expect(typed).toBeGreaterThan(marker)
    expect(enter).toBeGreaterThan(typed)
    expect(attach).toBeGreaterThan(enter)
    expect(script.match(/send-keys -t "\$session" -l/gu)).toHaveLength(1)
    expect(() => execFileSync('bash', ['-n', '-c', script])).not.toThrow()
    const relay = buildDevboxShellAttachCommand('devbox-roam-2-review', '/srv', 'roam', socket, { watcherScript: 'echo watcher' }, 'opus')
    expect(relay.indexOf('send-keys')).toBeLessThan(relay.indexOf('exec tmux'))
    expect(relay).toContain('echo watcher')
  })

  it('sends nothing when no command is given', () => {
    const script = buildDevboxShellAttachCommand('devbox-roam-2-review', '/srv', 'roam', socket)
    expect(script).not.toContain('send-keys -t "$session"')
    expect(script).not.toContain('@devbox-run-sent')
    expect(script).not.toContain('run=')
  })

  it('carries the command on every new attempt but never on attach or resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-new-run-'))
    const envFile = join(dir, 'env')
    writeFileSync(envFile, 'DEVBOX_TEST_TOKEN=synthetic\n', { mode: 0o600 })
    const run = vi.spyOn(shellTerminalAttach, 'runDevboxShellInteractive').mockResolvedValue(0)
    const options = { history: history(), reconnect: false, initialInput: 'opus --session abc' }
    const credentialRunner = runner()
    // The credential prepare script may create the session; the attach script still types once.
    await newDevboxShell('roam', 'review', '/remote', undefined, '/srv', credentialRunner, endpoint, undefined, envFile, false, options)
    rmSync(dir, { recursive: true, force: true })
    for (const [script] of vi.mocked(credentialRunner.script).mock.calls) {
      expect(script).not.toContain('send-keys -t "$session"')
    }
    expect(vi.mocked(credentialRunner.script).mock.calls.some(([script]) => script.includes('new-session -d -s "$session"'))).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]![1]).toContain("run='opus --session abc'")
    expect(run.mock.calls[0]![1]).toContain('@devbox-run-sent')
    run.mockClear()
    await attachDevboxShell('roam', undefined, '/remote', undefined, runner(), endpoint, undefined, undefined, false, options)
    await resumeDevboxShell('roam', '/remote', undefined, runner(), endpoint, history(), undefined, undefined, false, options)
    expect(run).toHaveBeenCalledTimes(2)
    for (const call of run.mock.calls) {
      expect(call[1]).not.toContain('@devbox-run-sent')
      expect(call[1]).not.toContain('send-keys -t "$session"')
    }
    run.mockRestore()
  })
})
