import { describe, expect, it } from 'vitest'
import {
  planDevboxShellReconnectAll,
  runDevboxShellReconnectAll,
  type DevboxShellReconnectAllTarget
} from './shell-reconnect-all'
import { runDevboxServiceShellReconnectEverywhere } from './shell-service-operations'
import type { DevboxShellAttachHistory, DevboxShellAttachRecord } from './shell-attach-history'
import type { DevboxShellDeviceResult } from './shell-devices'
import type { DevboxShellSession } from './shell-sessions'
import type { ForcaCommandResult, ForcaCommandRunner } from './forca-terminals'

type Call = {
  binary: string
  argv: readonly string[]
  options?: { cwd?: string; timeoutMs?: number }
}

function session(id: number, attached: boolean, name?: string, profileId = 'roam'): DevboxShellSession {
  return {
    id,
    ...(name === undefined ? {} : { name }),
    sessionName: `devbox-${profileId}-${id}${name === undefined ? '' : `-${name}`}`,
    created: id,
    attached,
    lastUsed: id,
    currentCommand: '',
    currentTitle: '',
    mostRecent: id === 1
  }
}

function roam(sessions: DevboxShellSession[]): DevboxShellReconnectAllTarget[] {
  return [{ profileId: 'roam', device: 'roam', sessions }]
}

function response(stdout: string, exitCode = 0, stderr = ''): ForcaCommandResult {
  return { stdout, stderr, exitCode }
}

/** `terminalList`: the `terminal list --json` stdout; the default is an older Forca's (no `devbox`). */
function forcaRunner(
  calls: Call[],
  fail: (command: string) => boolean = () => false,
  terminalList = '{"ok":true,"result":{"terminals":[{"handle":"term_plain","title":"Terminal 1"}],"totalCount":1,"truncated":false}}'
): ForcaCommandRunner {
  return async (binary, argv, options) => {
    calls.push({ binary, argv: [...argv], options })
    if (argv[0] === 'status') {return response('{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":true}}}')}
    if (argv[0] === 'worktree') {return response('{"ok":true,"result":{"worktree":{"path":"/repo"}}}')}
    if (argv[0] === 'terminal' && argv[1] === 'list') {return response(terminalList)}
    const command = argv[argv.indexOf('--command') + 1] ?? ''
    return fail(command)
      ? response('{"ok":false,"error":{"message":"tab failed"}}')
      : response(`{"ok":true,"result":{"terminal":{"handle":"term_${calls.length}"}}}`)
  }
}

function createCalls(calls: readonly Call[]): { command: string; title: string }[] {
  return calls.filter((call) => call.argv[0] === 'terminal' && call.argv[1] === 'create').map((call) => ({
    command: call.argv[call.argv.indexOf('--command') + 1]!,
    title: call.argv[call.argv.indexOf('--title') + 1]!
  }))
}

describe('shell reconnect-all planning', () => {
  it('selects here, Forca, and attached rows in id order and attaches by session name', () => {
    const rows = planDevboxShellReconnectAll(roam([
      session(4, false),
      session(1, true, 'main'),
      session(2, false, 'agents')
    ]), { profileId: 'roam', sessionName: 'devbox-roam-4' }, 'db')
    expect(rows).toEqual([
      { id: 1, name: 'main', sessionName: 'devbox-roam-1-main', profileId: 'roam', device: 'roam', title: 'main', action: 'skip-attached', command: 'db shell devbox-roam-1-main --profile roam' },
      { id: 2, name: 'agents', sessionName: 'devbox-roam-2-agents', profileId: 'roam', device: 'roam', title: 'agents', action: 'forca', command: 'db shell devbox-roam-2-agents --profile roam' },
      { id: 4, sessionName: 'devbox-roam-4', profileId: 'roam', device: 'roam', title: '#4', action: 'here', command: 'db shell devbox-roam-4 --profile roam' }
    ])
  })

  it('gives every session that shares a numeric id its own name-based command', () => {
    const rows = planDevboxShellReconnectAll(roam(['d4', 'd1', 'd3', 'd2'].map((name) => session(2, false, name, 'devbox'))), undefined, 'db')
    expect(rows.map((row) => [row.title, row.command])).toEqual([
      ['d1', 'db shell devbox-devbox-2-d1 --profile roam'],
      ['d2', 'db shell devbox-devbox-2-d2 --profile roam'],
      ['d3', 'db shell devbox-devbox-2-d3 --profile roam'],
      ['d4', 'db shell devbox-devbox-2-d4 --profile roam']
    ])
  })

  it('suffixes titles with the device only when they collide across devices', () => {
    const rows = planDevboxShellReconnectAll([
      { profileId: 'mini', device: 'mini', sessions: [session(1, false, 'main', 'mini'), session(2, false, undefined, 'mini')] },
      { profileId: 'box', device: 'box', sessions: [session(1, false, 'main', 'box'), session(3, false, undefined, 'box')] }
    ], undefined, 'db')
    expect(rows.map((row) => row.title)).toEqual(['main@mini', '#2', 'main@box', '#3'])
  })

  it('only resumes here the recorded session on its own profile', () => {
    const rows = planDevboxShellReconnectAll([
      { profileId: 'mini', device: 'mini', sessions: [session(1, false, undefined, 'mini')] },
      { profileId: 'box', device: 'box', sessions: [session(1, false, undefined, 'box')] }
    ], { profileId: 'box', sessionName: 'devbox-box-1' }, 'db')
    expect(rows.map((row) => `${row.profileId}:${row.action}`)).toEqual(['mini:forca', 'box:here'])
  })
})

describe('shell reconnect-all execution', () => {
  it('lists every unattached name-based command when Forca is missing', async () => {
    await expect(runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(1, false), session(2, false)]),
      here: { profileId: 'roam', sessionName: 'devbox-roam-1' },
      cwd: '/repo',
      dryRun: false,
      env: { PATH: '' },
      forcaBinary: '',
      devboxCommand: 'db'
    })).rejects.toThrow(
      'Forca CLI (forca) not found on PATH. Reconnect manually:\n  db shell devbox-roam-1 --profile roam\n  db shell devbox-roam-2 --profile roam'
    )
  })

  it('stops before worktree lookup when the runtime probe fails', async () => {
    const calls: Call[] = []
    const run: ForcaCommandRunner = async (binary, argv, options) => {
      calls.push({ binary, argv: [...argv], options })
      return response('{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":false}}}')
    }
    await expect(runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(2, false)]),
      cwd: '/repo',
      dryRun: false,
      env: {},
      forcaBinary: 'forca',
      run
    })).rejects.toThrow('Forca runtime is not reachable (runtime unreachable). Reconnect manually:')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['status', '--json'])
  })

  it('creates titled terminals sequentially and records launched and failed rows', async () => {
    const calls: Call[] = []
    const output = await runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(4, false), session(3, false, 'agents'), session(1, false), session(2, true)]),
      here: { profileId: 'roam', sessionName: 'devbox-roam-4' },
      cwd: '/repo',
      dryRun: false,
      env: {},
      forcaBinary: 'forca',
      devboxCommand: 'db',
      run: forcaRunner(calls, (command) => command.includes('agents'))
    })
    expect(output.profileId).toBe('roam')
    expect(output.scope).toBeUndefined()
    expect(output.worktreeSelector).toBe('path:/repo')
    expect(output.here).toEqual({ id: 4, sessionName: 'devbox-roam-4', profileId: 'roam' })
    expect(output.rows.map((row) => [row.id, row.action, row.status, row.handle ?? row.error ?? '-'])).toEqual([
      [1, 'forca', 'launched', 'term_4'],
      [2, 'skip-attached', 'planned', '-'],
      [3, 'forca', 'failed', 'tab failed'],
      [4, 'here', 'planned', '-']
    ])
    expect(calls.map((call) => call.argv.slice(0, 2).join(' '))).toEqual([
      'status --json',
      'worktree current',
      'terminal list',
      'terminal create',
      'terminal create'
    ])
    expect(calls[2]?.argv).toEqual(['terminal', 'list', '--json'])
    expect(createCalls(calls)).toEqual([
      { command: 'db shell devbox-roam-1 --profile roam', title: '#1' },
      { command: 'db shell devbox-roam-3-agents --profile roam', title: 'agents' }
    ])
  })

  it('skips sessions a Forca tab already shows (Forca publishing terminal devbox identities)', async () => {
    const calls: Call[] = []
    const terminalList = JSON.stringify({
      ok: true,
      result: {
        terminals: [
          { handle: 'term_plain', title: 'Terminal 1' },
          { handle: 'term_research', devbox: { profileId: 'roam', sessionName: 'devbox-roam-3-agents', label: 'agents', connection: 'reconnecting', program: 'phi' } },
          { handle: 'term_state', devbox: { identity: { profileId: 'roam', sessionName: 'devbox-roam-5' }, connection: 'attached' } },
          { handle: 'term_other_profile', devbox: { profileId: 'other', sessionName: 'devbox-other-1' } },
          { handle: 'term_bad', devbox: { profileId: 7, sessionName: null } }
        ]
      }
    })
    const output = await runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(1, false), session(3, false, 'agents'), session(5, false)]),
      cwd: '/repo',
      dryRun: false,
      env: {},
      forcaBinary: 'forca',
      devboxCommand: 'db',
      run: forcaRunner(calls, () => false, terminalList)
    })
    expect(output.rows.map((row) => [row.id, row.action, row.status, row.handle ?? '-'])).toEqual([
      [1, 'forca', 'launched', 'term_4'],
      [3, 'forca', 'already-open', 'term_research'],
      [5, 'forca', 'already-open', 'term_state']
    ])
    expect(createCalls(calls)).toEqual([{ command: 'db shell devbox-roam-1 --profile roam', title: '#1' }])
  })

  it.each([
    ['a failing terminal list', response('', 1, 'unknown command')],
    ['non-JSON output', response('not json')],
    ['ok:false', response('{"ok":false,"error":{"message":"nope"}}')]
  ])('launches every row when Forca answers terminal list with %s', async (_label, listResponse) => {
    const calls: Call[] = []
    const base = forcaRunner(calls)
    const run: ForcaCommandRunner = async (binary, argv, options) => argv[0] === 'terminal' && argv[1] === 'list'
      ? (calls.push({ binary, argv: [...argv], options }), listResponse)
      : base(binary, argv, options)
    const output = await runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(1, false), session(2, false)]),
      cwd: '/repo',
      dryRun: false,
      env: {},
      forcaBinary: 'forca',
      devboxCommand: 'db',
      run
    })
    expect(output.rows.map((row) => row.status)).toEqual(['launched', 'launched'])
  })

  it('leaves every row planned and never calls the runner in dry-run mode', async () => {
    const run: ForcaCommandRunner = async () => { throw new Error('runner must not be called') }
    const output = await runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(2, false), session(1, true)]),
      cwd: '/repo',
      dryRun: true,
      env: {},
      forcaBinary: 'forca',
      run
    })
    expect(output.worktreeSelector).toBeUndefined()
    expect(output.rows.every((row) => row.status === 'planned')).toBe(true)
  })

  it('does not resolve or touch Forca when there is nothing to launch', async () => {
    let calls = 0
    const run: ForcaCommandRunner = async () => {
      calls += 1
      return response('')
    }
    const output = await runDevboxShellReconnectAll({
      profileId: 'roam',
      targets: roam([session(1, true)]),
      cwd: '/repo',
      dryRun: false,
      env: {},
      run
    })
    expect(calls).toBe(0)
    expect(output.rows[0]?.status).toBe('planned')
  })
})

function device(name: string, status: DevboxShellDeviceResult['status'], sessions: DevboxShellSession[] = [], error?: string): DevboxShellDeviceResult {
  return {
    device: name,
    host: `${name}.local`,
    port: 22,
    username: 'dev',
    default: false,
    status,
    elapsedMs: 0,
    ...(error === undefined ? {} : { error }),
    profiles: [{ profileId: name, default: false, reachable: status === 'ok', mostRecentId: null, sessions }]
  }
}

function history(records: DevboxShellAttachRecord[]): DevboxShellAttachHistory {
  return {
    terminalKey: 'tty:/dev/ttys001',
    record: async () => undefined,
    lastForTerminal: async (profileId) => records.find((record) => record.profileId === profileId),
    lastForProfile: async () => undefined
  }
}

describe('shell reconnect-all across devices', () => {
  it('plans every reachable device with its own profile and reports unreachable ones', async () => {
    const output = await runDevboxServiceShellReconnectEverywhere({
      listAll: async () => ({
        scope: 'all-devices',
        devices: [
          device('mini', 'ok', [session(1, false, 'main', 'mini'), session(2, true, undefined, 'mini')]),
          device('laptop', 'unreachable', [], 'ssh: connect timed out'),
          device('box', 'ok', [session(1, false, 'main', 'box'), session(2, false, undefined, 'box')]),
          device('old', 'skipped', [], 'skipped: unreachable 30 s ago, --refresh to retry')
        ],
        sessionCount: 4,
        unreachableCount: 2,
        elapsedMs: 0
      }),
      history: history([
        { profileId: 'mini', sessionName: 'devbox-mini-1-main', id: 1, terminalKey: 'tty:/dev/ttys001', attachedAt: 10 },
        { profileId: 'box', sessionName: 'devbox-box-2', id: 2, terminalKey: 'tty:/dev/ttys001', attachedAt: 20 }
      ]),
      cwd: '/repo',
      dryRun: true,
      allowHere: true,
      env: {}
    })
    expect(output.profileId).toBeUndefined()
    expect(output.scope).toBe('all-devices')
    expect(output.skippedDevices).toEqual([
      { device: 'laptop', status: 'unreachable', error: 'ssh: connect timed out' },
      { device: 'old', status: 'skipped', error: 'skipped: unreachable 30 s ago, --refresh to retry' }
    ])
    expect(output.here).toEqual({ id: 2, sessionName: 'devbox-box-2', profileId: 'box' })
    expect(output.rows.map((row) => [row.device, row.title, row.action, row.command.replace(/^\S+ /u, '')])).toEqual([
      ['mini', 'main@mini', 'forca', 'shell devbox-mini-1-main --profile mini'],
      ['mini', '#2@mini', 'skip-attached', 'shell devbox-mini-2 --profile mini'],
      ['box', 'main@box', 'forca', 'shell devbox-box-1-main --profile box'],
      ['box', '#2@box', 'here', 'shell devbox-box-2 --profile box']
    ])
  })
})
