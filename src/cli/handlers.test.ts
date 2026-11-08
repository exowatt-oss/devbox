import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliArgumentError } from './args'
import { DEVBOX_HANDLERS, type HandlerContext } from './handlers'
import { visibleWidth } from './presentation'
import type { DevboxServiceLike } from './operations'

function fixture() {
  const calls: string[] = []
  const service: DevboxServiceLike = {
    start: vi.fn(async (id) => { calls.push(`start:${id}`); return { state: 'ready', profileId: id } }),
    status: vi.fn((id) => { calls.push(`status:${id}`); return { state: 'ready', profileId: id } }),
    disable: vi.fn(async (id) => { calls.push(`disable:${id}`); return { state: 'stopped', profileId: id } }),
    syncNow: vi.fn(async (options) => { calls.push(`sync-now:${JSON.stringify(options.selection)}`); return { ok: true, startedAt: 0, elapsedMs: 0, machines: [], syncedCount: 0, skippedCount: 0, failedCount: 0, interrupted: false } }),
    launchTerminal: vi.fn(async (...args) => { calls.push(`terminal:${args[2]}`); return { handle: 'terminal' } }),
    shellAttach: vi.fn(async (id, target) => { calls.push(`shell:${id}:${target}`); return { profileId: id, id: 1, sessionName: 'devbox-p1-1', ...(target === undefined ? {} : { name: target }), exitCode: 0 } }),
    shellNew: vi.fn(async (id, name, cwd, _markers, _reconnect, _relay, run) => { calls.push(`shell-new:${id}:${name}:${cwd}${run === undefined ? '' : `:${run}`}`); return { profileId: id, id: 2, sessionName: 'devbox-p1-2', ...(name === undefined ? {} : { name }), exitCode: 0 } }),
    shellResume: vi.fn(async (id) => { calls.push(`shell-resume:${id}`); return { profileId: id, id: 1, sessionName: 'devbox-p1-1', exitCode: 0 } }),
    shellReconnectAll: vi.fn(async (id) => { calls.push(`shell-reconnect-all:${id}`); return { profileId: id, dryRun: true, rows: [] } }),
    shellList: vi.fn(async (id) => { calls.push(`shell-list:${id}`); return { profileId: id, mostRecentId: null, sessions: [] } }),
    shellListAll: vi.fn(async () => ({ scope: 'all-devices' as const, devices: [], sessionCount: 0, unreachableCount: 0, elapsedMs: 0 })),
    shellLocate: vi.fn(async (target) => ({ profileId: 'p1', device: 'p1', note: `devbox: shell '${target}' is on device p1 (profile p1)` })),
    shellKill: vi.fn(async (id, name) => { calls.push(`shell-kill:${id}:${name}`); return { profileId: id, id: 1, sessionName: `devbox-p1-1-${name}`, name, killed: true as const } }),
    shellKillCurrent: vi.fn(async (id) => { calls.push(`shell-kill-current:${id}`); return { profileId: id, id: 1, sessionName: 'devbox-p1-1', killed: true as const } }),
    shellKillAll: vi.fn(async (id) => { calls.push(`shell-kill-all:${id}`); return { profileId: id, count: 0, sessions: [], killed: true as const } }),
    shellKillUnattached: vi.fn(async (id) => { calls.push(`shell-kill-unattached:${id}`); return { profileId: id, count: 2, sessions: ['devbox-p1-2', 'devbox-p1-3'], killed: true as const } }),
    shellKillUnattachedAll: vi.fn(async () => ({ scope: 'all-devices' as const, devices: [], count: 0 })),
    launchPhi: vi.fn(async () => ({ handle: 'phi' })),
    runConsistent: vi.fn(async (_id, job) => ({ job, attached: false })),
    openPort: vi.fn(async () => ({ localPort: 4000, remotePort: 3000 })),
    jobStatus: vi.fn(async () => null),
    cancelJob: vi.fn(async () => null),
    tailJobLog: vi.fn(async () => ({ jobId: 'job-1', text: 'secret' })),
    createProfile: vi.fn(async () => ({ profile: {} as never, fingerprints: [], knownHostsFile: '' })),
    listProfiles: vi.fn(() => ({ profiles: [] })),
    useProfile: vi.fn((profileId) => ({ defaultProfile: profileId ?? null })),
    setProfileEnvFile: vi.fn(async (profileId, envFile) => ({ profileId, envFile: envFile ?? null })),
    showProfileEnvFile: vi.fn((profileId) => ({ profileId, envFile: null })),
    setProfileShellDir: vi.fn(async (profileId, shellDir) => ({ profileId, shellDir: shellDir ?? null })),
    showProfileShellDir: vi.fn((profileId) => ({ profileId, shellDir: null })),
    setProfileProxyCommand: vi.fn(async (profileId, proxyCommand) => ({ profileId, proxyCommand: proxyCommand ?? null })),
    showProfileProxyCommand: vi.fn((profileId) => ({ profileId, proxyCommand: null })),
    setProfileDevice: vi.fn((profileId, device) => ({ profileId, device: device ?? null })),
    showProfileDevice: vi.fn((profileId) => ({ profileId, device: null })),
    setProfileMaxEntryCount: vi.fn(async (profileId, maxEntryCount) => ({ profileId, maxEntryCount: maxEntryCount ?? 2_000_000 })),
    showProfileMaxEntryCount: vi.fn((profileId) => ({ profileId, maxEntryCount: 2_000_000 })),
    setProfileWatchPollingInterval: vi.fn(async (profileId, watchPollingIntervalSeconds) => ({ profileId, watchPollingIntervalSeconds: watchPollingIntervalSeconds ?? null, effectiveWatchPollingIntervalSeconds: watchPollingIntervalSeconds ?? 10 })),
    showProfileWatchPollingInterval: vi.fn((profileId) => ({ profileId, watchPollingIntervalSeconds: null, effectiveWatchPollingIntervalSeconds: 10 })),
    addProfileIgnores: vi.fn(async () => ({ profileId: 'p1', action: 'add' as const, patterns: [], requiresRePair: true, message: '' })),
    listProfileIgnores: vi.fn(() => ({ profileId: 'p1', action: 'list' as const, patterns: [], requiresRePair: true, message: '' })),
    removeProfileIgnores: vi.fn(async () => ({ profileId: 'p1', action: 'rm' as const, patterns: [], requiresRePair: true, message: '' })),
    enableProfileCredentials: vi.fn(async () => ({ profileId: 'p1', enabled: true, roots: [] })),
    disableProfileCredentials: vi.fn(async () => ({ profileId: 'p1', enabled: false, roots: [] })),
    showProfileCredentials: vi.fn(() => ({ profileId: 'p1', enabled: false, roots: [] })),
    enableProfilePaste: vi.fn(async () => ({ profileId: 'p1', enabled: true, roots: [] })),
    disableProfilePaste: vi.fn(async () => ({ profileId: 'p1', enabled: false, roots: [] })),
    showProfilePaste: vi.fn(() => ({ profileId: 'p1', enabled: false, roots: [] })),
    preflight: vi.fn(async () => ({ status: 'ready', blockers: [] } as never))
  }
  return { service, calls }
}

function context(
  service: DevboxServiceLike,
  flags: Record<string, string | boolean>,
  rawArgs: string[] = [],
  selectedProfile?: HandlerContext['profile'],
  positionalArgs: string[] = [],
  presentation?: HandlerContext['presentation']
): HandlerContext {
  return {
    service,
    flags: new Map(Object.entries(flags)),
    cwd: '/workspace',
    json: true,
    rawArgs,
    profile: selectedProfile,
    positionalArgs,
    presentation
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('standalone Devbox handlers', () => {
  it('maps lifecycle, shell, git, jobs, and ports to the service surface', async () => {
    const { service, calls } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS.pair(context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS.status(context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS.disable(context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS.sync(context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', cwd: '/home/sample', run: 'opus --session abc' }, [], undefined, ['new', 'worker']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1' }, [], undefined, ['worker']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1' }, [], undefined, ['ls']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1' }, [], undefined, ['rm', 'worker']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1' }, [], undefined, ['rm', 'this']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1' }, [], undefined, ['rm', '2']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', unattached: true }, [], undefined, ['rm']))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', all: true }))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', name: 'worker' }))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', list: true }))
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', kill: 'worker' }))
    await DEVBOX_HANDLERS.git(context(service, { profile: 'p1', path: '/workspace' }, ['status']))
    await DEVBOX_HANDLERS['jobs status'](context(service, { profile: 'p1', 'job-id': 'j1' }))
    await DEVBOX_HANDLERS['jobs cancel'](context(service, { profile: 'p1', 'job-id': 'j1' }))
    await DEVBOX_HANDLERS['jobs log'](context(service, { profile: 'p1', 'job-id': 'j1' }))
    await DEVBOX_HANDLERS['ports open'](context(service, { profile: 'p1', 'remote-port': '3000' }))
    expect(calls).toEqual([
      'start:p1', 'status:p1', 'disable:p1', 'sync-now:{"profile":"p1"}',
      'shell:p1:undefined', 'shell-new:p1:worker:/home/sample:opus --session abc', 'shell:p1:worker',
      'shell-list:p1', 'shell-kill:p1:worker', 'shell-kill-current:p1', 'shell-kill:p1:2', 'shell-kill-unattached:p1', 'shell-kill-all:p1',
      'shell:p1:worker', 'shell-list:p1', 'shell-kill:p1:worker',
      'terminal:terminal'
    ])
    expect(service.launchTerminal).toHaveBeenLastCalledWith('p1', '/workspace', 'terminal', ['git', 'status'])
  })

  it('uses all-device listing for a configured default but keeps explicit listing stable', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS.shell({ ...context(service, { profile: 'p1' }, [], undefined, ['ls']), profileSelection: { profileId: 'p1', profile: {} as never, source: 'configured' } })
    expect(service.shellListAll).toHaveBeenCalledOnce()
    expect(service.shellList).not.toHaveBeenCalled()
  })

  it('allows profile-less rm this and forwards a cross-device target note only for human output', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS.shell(context(service, {}, [], undefined, ['rm', 'this']))
    expect(service.shellKillCurrent).toHaveBeenCalledWith(undefined)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await DEVBOX_HANDLERS.shell({ ...context(service, { profile: 'p1' }, [], undefined, ['worker']), profileSelection: { profileId: 'p1', profile: {} as never, source: 'configured' }, json: false })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('devbox: shell'))
  })

  it('maps all-device detached cleanup to its dedicated service result', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(service.shellKillUnattached).not.toHaveBeenCalled()
    await DEVBOX_HANDLERS.shell({ ...context(service, {}, [], undefined, ['rm']), flags: new Map([['unattached', true], ['all-devices', true]]) })
    expect(service.shellKillUnattachedAll).toHaveBeenCalledOnce()
  })

  it('prints reconnect-all then attaches the planned here session in place', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    vi.mocked(service.shellReconnectAll).mockResolvedValue({
      profileId: 'p1',
      dryRun: false,
      rows: [
        { id: 2, sessionName: 'devbox-p1-2-d2', profileId: 'p1', device: 'p1', title: 'd2', action: 'here', status: 'planned', command: 'devbox shell devbox-p1-2-d2 --profile p1' }
      ],
      here: { id: 2, sessionName: 'devbox-p1-2-d2', profileId: 'p1' }
    })
    try {
      await DEVBOX_HANDLERS.shell({
        ...context(service, { profile: 'p1', all: true }),
        json: false,
        positionalArgs: ['reconnect']
      })
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor)
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY
      }
    }
    expect(service.shellReconnectAll).toHaveBeenCalledWith('p1', {
      cwd: '/workspace',
      dryRun: false,
      worktreeOverride: undefined,
      allowHere: true
    })
    expect(service.shellAttach).toHaveBeenLastCalledWith('p1', 'devbox-p1-2-d2', true, true)
    expect(process.exitCode).toBe(0)
  })

  it('covers every device without an explicit selection and resumes here on the row profile', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    vi.mocked(service.shellReconnectAll).mockResolvedValue({
      scope: 'all-devices',
      dryRun: false,
      rows: [
        { id: 2, sessionName: 'devbox-box-2-d3', profileId: 'box', device: 'box', title: 'd3', action: 'here', status: 'planned', command: 'devbox shell devbox-box-2-d3 --profile box' }
      ],
      here: { id: 2, sessionName: 'devbox-box-2-d3', profileId: 'box' }
    })
    try {
      await DEVBOX_HANDLERS.shell({
        ...context(service, { profile: 'p1', all: true }),
        profileSelection: { profileId: 'p1', profile: {} as never, source: 'configured' },
        json: false,
        positionalArgs: ['reconnect']
      })
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor)
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY
      }
    }
    expect(service.shellReconnectAll).toHaveBeenCalledWith(undefined, expect.objectContaining({ allowHere: true }))
    expect(service.shellAttach).toHaveBeenLastCalledWith('box', 'devbox-box-2-d3', true, true)
  })

  it('downgrades reconnect-all here handling in JSON mode', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.mocked(service.shellReconnectAll).mockResolvedValue({
      profileId: 'p1',
      dryRun: false,
      rows: [{ id: 2, sessionName: 'devbox-p1-2', profileId: 'p1', device: 'p1', title: '#2', action: 'forca', status: 'planned', command: 'devbox shell devbox-p1-2 --profile p1' }]
    })
    await DEVBOX_HANDLERS.shell({
      ...context(service, { profile: 'p1', all: true }),
      positionalArgs: ['reconnect']
    })
    expect(service.shellReconnectAll).toHaveBeenCalledWith('p1', expect.objectContaining({ allowHere: false }))
    expect(service.shellAttach).not.toHaveBeenCalled()
  })

  it('labels unattached removal distinctly in JSON while preserving its result', async () => {
    const { service } = fixture()
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS.shell(context(service, { profile: 'p1', unattached: true }, [], undefined, ['rm']))
    const envelope = JSON.parse(String(output.mock.calls[0]?.[0])) as { command: string; result: { count: number; sessions: string[] } }
    expect(envelope.command).toBe('shell rm --unattached')
    expect(envelope.result).toEqual({ count: 2, sessions: ['devbox-p1-2', 'devbox-p1-3'], killed: true, profileId: 'p1' })
    expect(service.shellKillUnattached).toHaveBeenCalledWith('p1')
  })

  it('requires typed takeover confirmation and never lets yes bypass it', async () => {
    const { service } = fixture()
    await expect(DEVBOX_HANDLERS.pair(context(service, { profile: 'p1', force: true, yes: true }))).rejects.toBeInstanceOf(CliArgumentError)
    expect(service.start).not.toHaveBeenCalled()
  })

  it('validates run arguments with the shared IPC validator', async () => {
    const { service } = fixture()
    await expect(DEVBOX_HANDLERS.run(context(service, { profile: 'p1', id: 'j1', cwd: '/workspace', consistent: true }))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(service.runConsistent).not.toHaveBeenCalled()
  })

  it('defaults run to consistent mode, an auto ID, and the profile remote root', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS.run(
      context(
        service,
        { profile: 'p1' },
        ['/bin/sh', '-c', 'echo bare-run-ok'],
        { roots: { remoteRoot: '/remote/project' } } as never
      )
    )
    const run = vi.mocked(service.runConsistent).mock.calls[0]
    expect(run?.[0]).toBe('p1')
    expect(run?.[1]).toMatchObject({
      id: expect.stringMatching(/^job-\d{8}-\d{6}-[0-9a-f]{4}$/),
      cwd: '/remote/project',
      detached: true
    })
    expect(run?.[1].command).toEqual(['/bin/sh', '-c', 'echo bare-run-ok'])
  })

  it('maps profile list and use to the preference service', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile use']({
      ...context(service, {}),
      positionalArgs: ['p1']
    })
    await DEVBOX_HANDLERS['profile list'](context(service, {}))
    expect(service.useProfile).toHaveBeenCalledWith('p1')
    expect(service.listProfiles).toHaveBeenCalledOnce()
  })

  it('maps profile credential env-file set/show/clear to the selected profile', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile env-file set']({
      ...context(service, { profile: 'p1' }, [], undefined, ['/Users/sample/secrets.env']),
      cwd: '/Users/sample'
    })
    await DEVBOX_HANDLERS['profile env-file show'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile env-file'](context(service, { profile: 'p1', clear: true }))
    expect(service.setProfileEnvFile).toHaveBeenNthCalledWith(1, 'p1', '/Users/sample/secrets.env')
    expect(service.setProfileEnvFile).toHaveBeenNthCalledWith(2, 'p1', undefined)
    expect(service.showProfileEnvFile).toHaveBeenCalledWith('p1')
  })

  it('maps profile shell-dir set/show/clear to the selected profile', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile shell-dir set']({
      ...context(service, { profile: 'p1' }), positionalArgs: ['/home/sample']
    })
    await DEVBOX_HANDLERS['profile shell-dir show'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile shell-dir'](context(service, { profile: 'p1', clear: true }))
    expect(service.setProfileShellDir).toHaveBeenNthCalledWith(1, 'p1', '/home/sample')
    expect(service.showProfileShellDir).toHaveBeenCalledWith('p1')
    expect(service.setProfileShellDir).toHaveBeenNthCalledWith(2, 'p1', undefined)
  })

  it('maps profile proxy-command set/show/clear and rejects multi-line commands', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile proxy-command set']({ ...context(service, { profile: 'p1' }), positionalArgs: ['  /home/u/.local/bin/devbox proxy '] })
    await DEVBOX_HANDLERS['profile proxy-command show'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile proxy-command clear'](context(service, { profile: 'p1' }))
    expect(service.setProfileProxyCommand).toHaveBeenNthCalledWith(1, 'p1', '/home/u/.local/bin/devbox proxy')
    expect(service.showProfileProxyCommand).toHaveBeenCalledWith('p1')
    expect(service.setProfileProxyCommand).toHaveBeenNthCalledWith(2, 'p1', undefined)
    await expect(DEVBOX_HANDLERS['profile proxy-command set']({ ...context(service, { profile: 'p1' }), positionalArgs: ['nc a 22\nrm -rf /'] })).rejects.toThrow('newlines')
    await expect(DEVBOX_HANDLERS['profile proxy-command set']({ ...context(service, { profile: 'p1' }), positionalArgs: ['devbox', 'proxy'] })).rejects.toThrow('one argument')
  })

  it('maps profile watch polling interval set/show/clear and rejects invalid values', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile sync-watch-polling-interval set']({
      ...context(service, { profile: 'p1' }), positionalArgs: ['60']
    })
    await DEVBOX_HANDLERS['profile sync-watch-polling-interval show'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile sync-watch-polling-interval'](context(service, { profile: 'p1', clear: true }))
    expect(service.setProfileWatchPollingInterval).toHaveBeenNthCalledWith(1, 'p1', 60)
    expect(service.showProfileWatchPollingInterval).toHaveBeenCalledWith('p1')
    expect(service.setProfileWatchPollingInterval).toHaveBeenNthCalledWith(2, 'p1', undefined)
    await expect(DEVBOX_HANDLERS['profile sync-watch-polling-interval set']({
      ...context(service, { profile: 'p1' }), positionalArgs: ['0']
    })).rejects.toThrow('positive safe integer')
  })

  it('maps profile credential enable/disable/show and repeatable excludes', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile credentials enable'](context(service, {
      profile: 'p1',
      'local-root': '/local/.mcp-auth',
      'remote-root': '/remote/.mcp-auth',
      exclude: '*.tmp\u0000*.log'
    }))
    await DEVBOX_HANDLERS['profile credentials disable'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile credentials show'](context(service, { profile: 'p1' }))
    expect(service.enableProfileCredentials).toHaveBeenCalledWith('p1', {
      localRoot: '/local/.mcp-auth',
      remoteRoot: '/remote/.mcp-auth',
      excludes: ['*.tmp', '*.log']
    })
    expect(service.disableProfileCredentials).toHaveBeenCalledWith('p1')
    expect(service.showProfileCredentials).toHaveBeenCalledWith('p1')
  })

  it('maps profile paste enable/disable/show with repeatable patterns and the prepare skip', async () => {
    const { service } = fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_HANDLERS['profile paste enable'](context(service, {
      profile: 'p1',
      'local-root': '/tmp/devbox-temp/ab/cd/T',
      pattern: 'terminal-paste-*\u0000remote-paste-*',
      'skip-remote-prepare': true
    }))
    await DEVBOX_HANDLERS['profile paste enable'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile paste disable'](context(service, { profile: 'p1' }))
    await DEVBOX_HANDLERS['profile paste show'](context(service, { profile: 'p1' }))
    expect(service.enableProfilePaste).toHaveBeenNthCalledWith(1, 'p1', {
      localRoot: '/tmp/devbox-temp/ab/cd/T',
      remoteRoot: undefined,
      patterns: ['terminal-paste-*', 'remote-paste-*'],
      skipRemotePrepare: true
    })
    expect(service.enableProfilePaste).toHaveBeenNthCalledWith(2, 'p1', {
      localRoot: undefined,
      remoteRoot: undefined,
      patterns: [],
      skipRemotePrepare: false
    })
    expect(service.disableProfilePaste).toHaveBeenCalledWith('p1')
    expect(service.showProfilePaste).toHaveBeenCalledWith('p1')
  })

  it('renders a semantic blocked preflight with an adaptive blocker table', async () => {
    const { service } = fixture()
    vi.mocked(service.preflight).mockResolvedValue({
      status: 'blocked',
      blockedReason: 'ssh-unreachable',
      blockers: [
        { id: 'ssh-reachability', remediation: 'Reconnect and retry.' },
        { id: 'path-safety', remediation: 'Choose a non-conflicting workspace root.' }
      ]
    } as never)
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await DEVBOX_HANDLERS.preflight({
      ...context(
        service,
        { profile: 'p1' },
        [],
        undefined,
        [],
        { width: 48, env: { LANG: 'C', TERM: 'xterm-256color' }, isTTY: false }
      ),
      json: false
    })

    const text = output.mock.calls.flat().map(String).join('\n')
    expect(text).toContain('Status: [error] BLOCKED')
    expect(text).toContain('Reason: ssh-unreachable')
    expect(text).toContain('ID')
    expect(text).toContain('REMEDIATION')
    expect(text).toContain('ssh-reachability')
    expect(text).toContain('Reconnect and retry.')
    expect(text).not.toContain('\u001b[')
    expect(text.split('\n').every((line) => visibleWidth(line) <= 48)).toBe(true)
    expect(process.exitCode).toBe(1)
  })

  it('keeps ready and cancelled preflight output clean while preserving exit semantics', async () => {
    const { service } = fixture()
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const options = { width: 80, env: { LANG: 'C', TERM: 'dumb' }, isTTY: false }

    await DEVBOX_HANDLERS.preflight({
      ...context(service, { profile: 'p1' }, [], undefined, [], options),
      json: false
    })
    expect(output.mock.calls.flat().map(String).join('\n')).toContain('Status: [ok] READY')
    expect(output.mock.calls.flat().map(String).join('\n')).toContain('No blockers.')
    expect(process.exitCode).toBeUndefined()

    output.mockClear()
    vi.mocked(service.preflight).mockResolvedValue({
      status: 'cancelled',
      blockers: []
    } as never)
    await DEVBOX_HANDLERS.preflight({
      ...context(service, { profile: 'p1' }, [], undefined, [], options),
      json: false
    })
    const cancelled = output.mock.calls.flat().map(String).join('\n')
    expect(cancelled).toContain('Status: [warn] CANCELLED')
    expect(cancelled).toContain('cancelled by user')
    expect(cancelled).toContain('No blockers recorded before cancellation.')
    expect(process.exitCode).toBe(1)
  })

  it('preserves the raw preflight JSON and never adds presentation ANSI', async () => {
    const { service } = fixture()
    const value = {
      status: 'blocked',
      blockedReason: 'ssh-unreachable',
      blockers: [{ id: 'ssh-reachability', remediation: 'Reconnect and retry.' }],
      checks: [{ id: 'ssh-reachability', status: 'fail' }]
    }
    vi.mocked(service.preflight).mockResolvedValue(value as never)
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await DEVBOX_HANDLERS.preflight({
      ...context(service, { profile: 'p1' }),
      json: true,
      presentation: { color: 'always', width: 20, isTTY: true }
    })

    expect(output).toHaveBeenCalledOnce()
    expect(output.mock.calls[0]?.[0]).toBe(JSON.stringify(value, null, 2))
    expect(String(output.mock.calls[0]?.[0])).not.toContain('\u001b[')
  })

  it('only emits preflight colour for a TTY and honours NO_COLOR', async () => {
    const { service } = fixture()
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const tty = { width: 80, env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, isTTY: true }

    await DEVBOX_HANDLERS.preflight({
      ...context(service, { profile: 'p1' }, [], undefined, [], tty),
      json: false
    })
    expect(output.mock.calls.flat().map(String).join('\n')).toContain('\u001b[')

    output.mockClear()
    await DEVBOX_HANDLERS.preflight({
      ...context(service, { profile: 'p1' }, [], undefined, [], {
        ...tty,
        env: { ...tty.env, NO_COLOR: '' }
      }),
      json: false
    })
    expect(output.mock.calls.flat().map(String).join('\n')).not.toContain('\u001b[')
  })

  it('does not invoke a service operation for blocked commands', async () => {
    const { service } = fixture()
    await expect(DEVBOX_HANDLERS.support(context(service, { profile: 'p1' }))).rejects.toMatchObject({ code: 'devbox_operation_blocked' })
    expect(service.start).not.toHaveBeenCalled()
  })
})
