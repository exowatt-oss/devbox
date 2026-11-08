import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxPreflightResult } from '../core/devbox-preflight'
import type { DevboxProfileSshTarget } from './profile-ssh'
import type { InitWorkspaceInput, MutagenSetupResult } from './hub-types'
import type { HubReadResult } from './hub-registry'
import type { WorkspaceBootstrapDeps } from './workspace-bootstrap'
import { runWorkspaceBootstrap, sanitizeProfileId } from './workspace-bootstrap'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const profile = (id = 'workspace', localRoot = '/tmp/local', remoteRoot = '/home/dev/workspace') => ({
  schemaVersion: 1,
  id,
  displayName: id,
  roots: { localRoot, remoteRoot },
  sshTarget: { identity: { host: '203.0.113.10', port: 22, username: 'dev', hostKeyFingerprint: 'SHA256:test' } }
} as unknown as DevboxProfileV1)

const setupResult: MutagenSetupResult = {
  profileId: 'workspace',
  service: { platform: 'linux', manager: 'systemd-user', label: 'devbox-mutagen-daemon.service', unitPath: '/tmp/unit', wrapperPath: '/tmp/wrapper', logPath: '/tmp/log', installed: true, loaded: true, running: true, pid: 42, action: 'unchanged' },
  daemon: { running: true, pid: 42, origin: 'service', binaryPath: '/tmp/mutagen', version: '0.18.1', dataDirectory: '/tmp/mutagen', lastCycleAt: null },
  hub: null,
  legacyWrapper: null,
  hints: []
}

type Scenario = {
  remoteOutput?: string
  remoteError?: string
  existing?: boolean
  preflight?: 'ready' | 'blocked'
  pairError?: string
  noPair?: boolean
  registerError?: string
  serviceError?: string
  defaultProfile?: string
  resolveRemoteHome?: string
  commandOutput?: (command: string) => string
  spokeRoot?: boolean
}

async function makeDeps(scenario: Scenario = {}): Promise<{ deps: WorkspaceBootstrapDeps; root: string; sshCalls: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'devbox-bootstrap-'))
  cleanup.push(root)
  const sshCalls: string[] = []
  const remote = {
    command: async (command: string, timeoutMs?: number) => {
      sshCalls.push(`command:${timeoutMs ?? 0}:${command}`)
      if (scenario.commandOutput) {return scenario.commandOutput(command)}
      if (command.includes('command -v tmux')) {return '/usr/bin/tmux'}
      if (command.includes('loginctl show-user')) {return 'yes'}
      if (command.includes('sudo -n true')) {return 'yes'}
      if (command.includes('systemctl --user')) {return 'running'}
      return ''
    },
    script: async (script: string, timeoutMs?: number) => {
      sshCalls.push(`script:${timeoutMs ?? 0}:${script}`)
      if (scenario.remoteError) {throw new Error(scenario.remoteError)}
      return scenario.remoteOutput ?? 'TMUX=yes\nLINGER=yes\nSUDO=yes\nUSERMGR=running\n'
    }
  }
  const target = { profile: profile(), endpoint: { host: '203.0.113.10', port: 22, username: 'dev' }, ssh: remote } as unknown as DevboxProfileSshTarget
  const deps: WorkspaceBootstrapDeps = {
    stateRoot: join(root, 'state'),
    profileRoot: join(root, 'profiles'),
    env: { HOME: root },
    home: root,
    hostname: 'laptop',
    username: 'dev',
    devboxVersion: '0.3.0',
    localFacts: { hostname: 'laptop', addresses: ['192.0.2.20'] },
    loadProfile: () => scenario.existing ? profile() : undefined,
    createProfile: async (input) => ({ profile: profile(input.profileId, input.localRoot, input.remoteRoot), fingerprints: ['SHA256:test', 'SHA256:other'], knownHostsFile: join(root, 'known_hosts'), ...(input.dryRun ? { dryRun: true } : {}) }),
    sshTarget: () => target,
    preflight: async () => scenario.preflight === 'blocked' ? ({ status: 'blocked', blockers: [{ id: 'remote', remediation: 'fix remote' }], checks: [] } as unknown as DevboxPreflightResult) : ({ status: 'ready', blockers: [], checks: [] } as unknown as DevboxPreflightResult),
    pair: async () => { if (scenario.pairError) {throw new Error(scenario.pairError)}; return { state: 'paired', sessions: 1 } },
    configuredDefaultProfile: () => scenario.defaultProfile,
    useProfile: vi.fn(),
    setProfileEnvFile: vi.fn(async () => ({})),
    setProfileShellDir: vi.fn(async () => ({})),
    mutagenSetup: async () => { if (scenario.serviceError) {throw new Error(scenario.serviceError)}; return setupResult },
    resolveRemoteHome: async () => scenario.resolveRemoteHome ?? '/srv/dev',
    register: async () => { if (scenario.registerError) {throw new Error(scenario.registerError)}; return { spokes: [{ spokeId: 'spoke' }] } },
    readHub: async (_target, spokeId): Promise<HubReadResult> => ({ reachable: true, hubId: 'hub-id', root: '/srv/dev/workspace', host: '203.0.113.10', port: 22, user: 'dev', registered: false, record: null, spokes: [], thisSpokeId: spokeId, liveAgentCount: 0, rootState: 'exists-empty', isSpokeRoot: scenario.spokeRoot === true })
  }
  return { deps, root, sshCalls }
}

function initInput(root: string, overrides: Partial<InitWorkspaceInput> = {}): InitWorkspaceInput {
  return { host: '203.0.113.10', port: 22, user: 'dev', localRoot: join(root, 'workspace'), remoteRoot: '/srv/dev/workspace', yes: true, force: true, service: false, pair: true, adoptRemote: false, ...overrides }
}

describe('runWorkspaceBootstrap', () => {
  it('keeps macOS remote bootstrap on launchd and reports linger as n/a', async () => {
    const { deps, root, sshCalls } = await makeDeps({
      noPair: true,
      remoteOutput: 'OS=Darwin\nTMUX=yes\nLINGER=n/a\nSUDO=no\nUSERMGR=launchd\n',
      commandOutput: (command) => command.includes('command -v tmux') ? '/opt/homebrew/bin/tmux' : command === 'uname -s' ? 'Darwin\n' : ''
    })
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root, { pair: false }))
    expect(result.steps.find(({ id }) => id === 'remote')?.detail).toContain('linger n/a')
    expect(result.steps.find(({ id }) => id === 'remote')?.detail).toContain('launchd')
    expect(sshCalls.some((call) => call.includes('loginctl') || call.includes('systemctl'))).toBe(false)
  })

  it('runs all eleven steps in order, reports each progress event once, and becomes ready', async () => {
    const { deps, root } = await makeDeps({ defaultProfile: 'workspace' })
    const progress: string[] = []
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root), (step) => progress.push(step.id))

    expect(result.steps.map((step) => step.id)).toEqual(['local-root', 'host-key', 'profile', 'remote', 'preflight', 'default-profile', 'env-file', 'shell-dir', 'service', 'pair', 'hub-registry'])
    expect(progress).toHaveLength(11)
    expect(progress).toEqual(result.steps.map((step) => step.id))
    expect(result.status).toBe('ready')
    expect(result.nextSteps[0]).toBe('devbox status')
  })

  it.each([
    ['init', false],
    ['connect', true]
  ] as const)('refuses %s against a spoke root in the remote step before preflight or pairing', async (mode, isConnect) => {
    const { deps, root } = await makeDeps({ spokeRoot: true })
    const preflight = vi.fn(deps.preflight)
    const pair = vi.fn(deps.pair)
    const register = vi.fn(deps.register!)
    deps.preflight = preflight
    deps.pair = pair
    deps.register = register
    const input = isConnect
      ? { host: '203.0.113.10', port: 22, user: 'dev', remoteRoot: '/srv/dev/workspace', localRoot: join(root, 'local'), yes: true, force: true, service: false, pair: true, allowNonEmptyLocal: true }
      : initInput(root, { adoptRemote: true })
    const result = await runWorkspaceBootstrap(deps, mode, input)
    expect(result.status).toBe('failed')
    expect(result.steps.map((step) => step.id)).toEqual(['local-root', 'host-key', 'profile', 'remote'])
    expect(result.steps.at(-1)).toMatchObject({ id: 'remote', status: 'failed' })
    expect(result.steps.at(-1)?.detail).toContain("Connect to that machine's hub instead.")
    expect(preflight).not.toHaveBeenCalled()
    expect(pair).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('stops at a non-empty init remote root unless --adopt-remote is used', async () => {
    const { deps, root } = await makeDeps({ remoteError: 'REMOTE-NONEMPTY' })
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root))

    expect(result.steps.map((step) => step.id)).toEqual(['local-root', 'host-key', 'profile', 'remote'])
    expect(result.steps.at(-1)).toMatchObject({ id: 'remote', status: 'failed' })
    expect(result.steps.at(-1)?.detail).toContain('devbox connect')
    expect(result.status).toBe('failed')
  })

  it('pins --proxy-command into both profile creates and scans keys through it only once', async () => {
    const { deps, root } = await makeDeps({ defaultProfile: 'workspace' })
    const creates: { input: { proxyCommand?: string; host: string; dryRun?: boolean }; keyscan: boolean }[] = []
    const original = deps.createProfile!
    deps.createProfile = async (input, options) => { creates.push({ input, keyscan: options?.keyscan !== undefined }); return original(input, options) }
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root, { host: 'devbox', proxyCommand: '/home/u/.local/bin/devbox proxy' }))
    expect(result.status).toBe('ready')
    expect(creates.map(({ input }) => [input.host, input.proxyCommand, input.dryRun])).toEqual([['devbox', '/home/u/.local/bin/devbox proxy', true], ['devbox', '/home/u/.local/bin/devbox proxy', false]])
    expect(creates.every(({ keyscan }) => keyscan)).toBe(true)
  })

  it('derives init remoteRoot from the remote home when it was omitted', async () => {
    const { deps, root } = await makeDeps({ resolveRemoteHome: '/srv/custom' })
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root, { remoteRoot: undefined }))

    expect(result.remoteRoot).toBe(`/srv/custom/${basename(join(root, 'workspace'))}`)
  })

  it('refuses a non-empty connect local root before any SSH work', async () => {
    const { deps, root, sshCalls } = await makeDeps()
    const localRoot = join(root, 'existing')
    await mkdir(localRoot)
    await writeFile(join(localRoot, 'keep.txt'), 'local')
    const result = await runWorkspaceBootstrap(deps, 'connect', { host: '203.0.113.10', port: 22, user: 'dev', remoteRoot: '/hub/workspace', localRoot, yes: true, force: true, service: false, pair: true, allowNonEmptyLocal: false })

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ id: 'local-root', status: 'failed' })
    expect(sshCalls).toEqual([])
  })

  it('rejects a local hub host before resolving an SSH target', async () => {
    const { deps, root, sshCalls } = await makeDeps()
    let targetCalls = 0
    deps.localFacts = { hostname: 'laptop', addresses: ['192.0.2.20'] }
    deps.sshTarget = () => { targetCalls += 1; throw new Error('SSH must not run') }
    await expect(runWorkspaceBootstrap(deps, 'connect', { host: '192.0.2.20', port: 22, user: 'dev', remoteRoot: '/hub/workspace', localRoot: join(root, 'local'), yes: true, force: true, service: false, pair: true, allowNonEmptyLocal: true })).rejects.toThrow('local ↔ local')
    expect(targetCalls).toBe(0)
    expect(sshCalls).toEqual([])
  })

  it('fails host-key acceptance with every scanned fingerprint', async () => {
    const { deps, root } = await makeDeps()
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root, { yes: false }))

    expect(result.steps).toHaveLength(2)
    expect(result.steps[1]).toMatchObject({ id: 'host-key', status: 'failed' })
    expect(result.steps[1]?.detail).toContain('SHA256:test')
    expect(result.steps[1]?.detail).toContain('SHA256:other')
  })

  it('fails at profile, not host-key, when an existing profile is not forced', async () => {
    const { deps, root } = await makeDeps({ existing: true })
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root, { force: false }))

    expect(result.steps.at(-1)).toMatchObject({ id: 'profile', status: 'failed' })
    expect(result.steps.at(-1)?.detail).toContain('--force')
    expect(result.steps.at(-1)?.detail).toContain('devbox mutagen setup --profile')
  })

  it('keeps the profile and blocks on preflight with remediation', async () => {
    const { deps, root } = await makeDeps({ preflight: 'blocked', defaultProfile: 'workspace' })
    const result = await runWorkspaceBootstrap(deps, 'init', initInput(root))

    expect(result.status).toBe('blocked')
    expect(result.steps.at(-1)).toMatchObject({ id: 'preflight', status: 'failed' })
    expect(result.nextSteps[0]).toBe('devbox preflight --json')
  })

  it('blocks when pairing throws and when pairing is explicitly skipped', async () => {
    const throwing = await makeDeps({ pairError: 'pair unavailable' })
    const failed = await runWorkspaceBootstrap(throwing.deps, 'init', initInput(throwing.root))
    expect(failed.status).toBe('blocked')
    expect(failed.steps.at(-1)).toMatchObject({ id: 'pair', status: 'failed' })
    expect(failed.nextSteps).toEqual(['devbox pair'])

    const skipped = await makeDeps({ defaultProfile: 'workspace' })
    const noPair = await runWorkspaceBootstrap(skipped.deps, 'init', initInput(skipped.root, { pair: false }))
    expect(noPair.status).toBe('blocked')
    expect(noPair.nextSteps).toEqual(['devbox pair'])
  })

  it('treats registry and service failures as warnings while continuing', async () => {
    const registry = await makeDeps({ registerError: 'registry unavailable' })
    const registryResult = await runWorkspaceBootstrap(registry.deps, 'init', initInput(registry.root, { service: false }))
    expect(registryResult.status).toBe('ready')
    expect(registryResult.steps.at(-1)).toMatchObject({ id: 'hub-registry', status: 'warning' })

    const service = await makeDeps({ serviceError: 'service unavailable' })
    const serviceResult = await runWorkspaceBootstrap(service.deps, 'init', initInput(service.root, { service: true }))
    expect(serviceResult.status).toBe('ready')
    expect(serviceResult.steps.find((step) => step.id === 'service')).toMatchObject({ status: 'warning' })
    expect(serviceResult.steps.find((step) => step.id === 'pair')).toMatchObject({ status: 'ok' })
  })

  it('warns, rather than failing, when remote tmux or linger setup is unavailable', async () => {
    const { deps, root } = await makeDeps({ remoteOutput: 'TMUX=no\nLINGER=no\nSUDO=no\nUSERMGR=unknown\n', commandOutput: (command) => command.includes('command -v tmux') ? '' : command.includes('sudo -n true') ? '' : 'unknown' })
    const result = await runWorkspaceBootstrap(deps, 'connect', { host: '203.0.113.10', port: 22, user: 'dev', remoteRoot: '/hub/workspace', localRoot: join(root, 'local'), yes: true, force: true, service: false, pair: false, allowNonEmptyLocal: true })

    expect(result.steps.find((step) => step.id === 'remote')).toMatchObject({ status: 'warning' })
    expect(result.steps.find((step) => step.id === 'remote')?.detail).toContain('sudo -n loginctl enable-linger')
  })

  it('sanitizes profile IDs to a 64-character alphanumeric-starting value', () => {
    expect(sanitizeProfileId('1 workspace')).toBe('1-workspace')
    expect(sanitizeProfileId('---')).toBe('devbox')
    expect(sanitizeProfileId('')).toBe('devbox')
    expect(sanitizeProfileId('x'.repeat(100))).toHaveLength(64)
  })
})
