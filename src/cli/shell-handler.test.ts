import { describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from './handlers'
import type { DevboxServiceLike } from './operations'
import { killCurrentDevboxShellLocally } from './shell-current'
import { handleShell } from './shell-handler'

// `db shell rm this` used to map every failure to "TMUX is not set", hiding the
// real reason. Only a missing TMUX/TMUX_PANE keeps that wording now.

function rmThis(shellKillCurrent: DevboxServiceLike['shellKillCurrent']): Promise<void> {
  const service = { shellKillCurrent } as unknown as DevboxServiceLike
  const ctx: HandlerContext = {
    flags: new Map(),
    service,
    cwd: '/tmp',
    json: true,
    positionalArgs: ['rm', 'this']
  }
  return handleShell(ctx)
}

function killWith(env: NodeJS.ProcessEnv, sessionOutput: string | Error): DevboxServiceLike['shellKillCurrent'] {
  const displayMessage = (): string => {
    if (sessionOutput instanceof Error) {throw sessionOutput}
    return sessionOutput
  }
  return async (profileId) => killCurrentDevboxShellLocally(env, vi.fn(), profileId, displayMessage)
}

const insideTmux = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3' }

describe('db shell rm this error reporting', () => {
  it('says TMUX is not set only when TMUX/TMUX_PANE are missing', async () => {
    await expect(rmThis(killWith({}, 'devbox-p1-1\n'))).rejects.toThrow(
      'devbox shell rm this must run inside a devbox shell (TMUX is not set)'
    )
    await expect(rmThis(killWith({ TMUX: insideTmux.TMUX }, 'devbox-p1-1\n'))).rejects.toThrow('TMUX is not set')
  })

  it('surfaces a session outside the Devbox prefix', async () => {
    const result = rmThis(killWith(insideTmux, 'scratch\n'))
    await expect(result).rejects.toThrow('Refusing tmux session outside the Devbox prefix: scratch')
    await expect(rmThis(killWith(insideTmux, 'scratch\n'))).rejects.not.toThrow('TMUX is not set')
  })

  it('surfaces a session not owned by Devbox', async () => {
    await expect(rmThis(killWith(insideTmux, 'devbox-other\n'))).rejects.toThrow('not owned by Devbox')
  })

  it('surfaces an unresolvable current tmux session', async () => {
    await expect(rmThis(killWith(insideTmux, new Error('no server running')))).rejects.toThrow(
      'could not resolve the current tmux session'
    )
  })

  it('rethrows other service failures unchanged', async () => {
    const failure = new Error('tmux kill-session failed: permission denied')
    await expect(rmThis(async () => { throw failure })).rejects.toBe(failure)
  })
})
