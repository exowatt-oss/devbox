import { describe, expect, it, vi } from 'vitest'
import {
  buildDevboxShellKillIfUnattachedCommand,
  killCurrentDevboxShellLocally,
  resolveCurrentDevboxShellSession
} from './shell-current'

describe('current Devbox shell resolution', () => {
  it('requires inherited tmux identity before invoking tmux', () => {
    const displayMessage = vi.fn(() => 'devbox-roam-1\n')
    expect(() => resolveCurrentDevboxShellSession({}, displayMessage)).toThrow('TMUX and TMUX_PANE')
    expect(displayMessage).not.toHaveBeenCalled()
  })

  it('uses exec-style tmux argv and preserves the inherited environment', () => {
    const env = { TMUX: '/tmp/tmux/default,123,0', TMUX_PANE: '%9' }
    const displayMessage = vi.fn((args: readonly string[], receivedEnv: NodeJS.ProcessEnv) => {
      expect(args).toEqual(['display-message', '-p', '-t', '%9', '#{session_name}'])
      expect(receivedEnv).toBe(env)
      return 'devbox-roam-1\n'
    })
    expect(resolveCurrentDevboxShellSession(env, displayMessage)).toBe('devbox-roam-1')
    expect(displayMessage).toHaveBeenCalledOnce()
  })

  it('rejects tmux lookup failures and ambiguous output', () => {
    expect(() => resolveCurrentDevboxShellSession(
      { TMUX: 'socket,123,0', TMUX_PANE: '%1' },
      () => { throw new Error('not in tmux') }
    )).toThrow('could not resolve')
    expect(() => resolveCurrentDevboxShellSession(
      { TMUX: 'socket,123,0', TMUX_PANE: '%1' },
      () => 'one\ntwo\n'
    )).toThrow('exactly one')
  })

  it('kills the current session locally with the inherited environment', () => {
    const env = { TMUX: '/tmp/devbox-abc,123,0', TMUX_PANE: '%9' }
    const exec = vi.fn()
    const result = killCurrentDevboxShellLocally(env, exec, undefined, () => 'devbox-roam-2-ansyshuge\n')
    expect(result).toMatchObject({ profileId: 'roam', id: 2, name: 'ansyshuge', killed: true })
    expect(exec).toHaveBeenCalledWith('tmux', ['kill-session', '-t', 'devbox-roam-2-ansyshuge'], expect.objectContaining({ env }))
  })

  it('emits server-side evidence before killing the exact last-session target', () => {
    const command = buildDevboxShellKillIfUnattachedCommand('devbox-roam-1')
    expect(command).toContain('tmux if-shell -F -t')
    expect(command).toContain('display-message -p -t')
    expect(command).toContain('#{session_name}')
    expect(command.indexOf('display-message -p')).toBeLessThan(command.indexOf('kill-session -t'))
    expect(command).not.toContain('kill-server')
    expect(command).not.toContain('*')
  })
})
