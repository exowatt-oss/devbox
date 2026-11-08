import { describe, expect, it } from 'vitest'
import {
  buildDevboxShellAttachCommandLine,
  createForcaTerminal,
  findForcaCli,
  probeForcaRuntime,
  quoteForPosixShell,
  resolveDevboxSelfCommand,
  resolveForcaWorktreeSelector,
  runForcaCommand,
  type ForcaCommandResult,
  type ForcaCommandRunner
} from './forca-terminals'

type Call = {
  binary: string
  argv: readonly string[]
  options?: { cwd?: string; timeoutMs?: number }
}

function result(stdout: string, exitCode = 0, stderr = ''): ForcaCommandResult {
  return { stdout, stderr, exitCode }
}

function recordingRunner(response: ForcaCommandResult | ((call: Call) => ForcaCommandResult)):
  { calls: Call[]; run: ForcaCommandRunner } {
  const calls: Call[] = []
  const run: ForcaCommandRunner = async (binary, argv, options) => {
    const call = { binary, argv: [...argv], options }
    calls.push(call)
    return typeof response === 'function' ? response(call) : response
  }
  return { calls, run }
}

describe('Forca terminal helpers', () => {
  it('resolves a missing executable as exit 127 instead of rejecting', async () => {
    const output = await runForcaCommand('/definitely/missing/forca', ['status', '--json'])
    expect(output.exitCode).toBe(127)
    expect(output.stderr).toMatch(/ENOENT/u)
  })

  it('probes a ready runtime', async () => {
    const { calls, run } = recordingRunner(result('{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":true}}}'))
    await expect(probeForcaRuntime(run, '/bin/forca')).resolves.toEqual({ ok: true })
    expect(calls[0]).toEqual({ binary: '/bin/forca', argv: ['status', '--json'], options: undefined })
  })

  it('reports app-not-running, non-JSON, and non-zero probe failures', async () => {
    const app = recordingRunner(result('{"ok":true,"result":{"app":{"running":false},"runtime":{"reachable":false}}}'))
    await expect(probeForcaRuntime(app.run, 'forca')).resolves.toEqual({ ok: false, reason: 'app not running' })

    const garbage = recordingRunner(result('not json'))
    await expect(probeForcaRuntime(garbage.run, 'forca')).resolves.toEqual({ ok: false, reason: 'non-JSON output' })

    const failed = recordingRunner(result('', 9, 'connection refused'))
    await expect(probeForcaRuntime(failed.run, 'forca')).resolves.toEqual({ ok: false, reason: 'exit code 9' })

    const unreachable = recordingRunner(result('{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":false}}}'))
    await expect(probeForcaRuntime(unreachable.run, 'forca')).resolves.toEqual({ ok: false, reason: 'runtime unreachable' })
  })

  it('uses an override, current worktree path, or active fallback', async () => {
    const override = recordingRunner(result(''))
    await expect(resolveForcaWorktreeSelector(override.run, 'forca', '/repo', 'name:custom')).resolves.toBe('name:custom')
    expect(override.calls).toHaveLength(0)

    const current = recordingRunner(result('{"ok":true,"result":{"worktree":{"path":"/repo"}}}'))
    await expect(resolveForcaWorktreeSelector(current.run, 'forca', '/repo')).resolves.toBe('path:/repo')
    expect(current.calls[0]?.options).toEqual({ cwd: '/repo' })

    const outside = recordingRunner(result('{"ok":false}', 1))
    await expect(resolveForcaWorktreeSelector(outside.run, 'forca', '/tmp')).resolves.toBe('active')
  })

  it('builds exact create argv and extracts nested handles', async () => {
    const { calls, run } = recordingRunner(result('{"ok":true,"result":{"terminal":{"handle":"term_1"},"tabId":"tab_1"}}'))
    await expect(createForcaTerminal(run, 'forca', {
      worktreeSelector: 'path:/repo',
      command: 'devbox shell 7 --profile roam',
      title: 'roam shell',
      cwd: '/repo'
    })).resolves.toEqual({
      ok: true,
      handle: 'term_1',
      tabId: 'tab_1',
      raw: { ok: true, result: { terminal: { handle: 'term_1' }, tabId: 'tab_1' } }
    })
    expect(calls[0]).toEqual({
      binary: 'forca',
      argv: ['terminal', 'create', '--worktree', 'path:/repo', '--command', 'devbox shell 7 --profile roam', '--title', 'roam shell', '--json'],
      options: { cwd: '/repo' }
    })
  })

  it('handles create envelopes that fail or are not JSON', async () => {
    const failed = recordingRunner(result('{"ok":false,"error":{"message":"denied"}}'))
    await expect(createForcaTerminal(failed.run, 'forca', { worktreeSelector: 'active', command: 'devbox shell 1 --profile p' }))
      .resolves.toEqual({ ok: false, reason: 'denied' })

    const garbage = recordingRunner(result('garbage'))
    await expect(createForcaTerminal(garbage.run, 'forca', { worktreeSelector: 'active', command: 'devbox shell 1 --profile p' }))
      .resolves.toEqual({ ok: false, reason: 'non-JSON output' })
  })

  it('quotes only tokens that need POSIX shell protection', () => {
    expect(quoteForPosixShell(['devbox', 'shell', '7', '--profile', 'roam'])).toBe('devbox shell 7 --profile roam')
    expect(quoteForPosixShell(['hello world', "it's", '', 'safe_./:=@%+-'])).toBe("'hello world' 'it'\\''s' '' safe_./:=@%+-")
    expect(buildDevboxShellAttachCommandLine('db', "profile name", 'devbox-roam-7')).toBe("db shell devbox-roam-7 --profile 'profile name'")
    expect(buildDevboxShellAttachCommandLine('db', 'devbox', 'devbox-devbox-2-d3')).toBe('db shell devbox-devbox-2-d3 --profile devbox')
  })

  it('uses the SEA executable only for a SEA build', () => {
    expect(resolveDevboxSelfCommand(['node', 'devbox'], '/tmp/devbox', () => false)).toBe('devbox')
    expect(resolveDevboxSelfCommand(['node', 'devbox'], '/tmp/devbox', () => true)).toBe('/tmp/devbox')
    expect(resolveDevboxSelfCommand(['node', 'db'], '/tmp/db', () => true)).toBe('/tmp/db')
  })

  it('finds PATH entries before the Homebrew fallback', () => {
    expect(findForcaCli({ PATH: '' }, { exists: () => true })).toBe('/opt/homebrew/bin/forca')
  })
})
