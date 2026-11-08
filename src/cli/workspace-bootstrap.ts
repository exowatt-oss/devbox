import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { DevboxPreflightResult } from '../core/devbox-preflight'
import { createProfile, type ProfileCreateInput, type ProfileCreateResult, type ScannedKey } from './profile-create'
import type { DevboxProfileSshTarget } from './profile-ssh'
import { ensureDevboxTmux } from './shell-tmux'
import { assertHubIsNotLocal, type LocalHostFacts } from './hub-local-guard'
import { commandExecFileAsync } from '../shared/exec'
import { createSystemSshRunner } from '../ssh/system-ssh-runner'
import { proxySshOptions } from '../ssh/ssh-proxy'
import { scanSshKeysThroughProxy } from './ssh-proxy-keyscan'
import { hubIdForRoot, loadOrCreateSpokeIdentity, recordSpokeRoot } from './spoke-identity'
import { readHub, registerHubAndSpoke, type HubRegistryTarget, type SpokeFacts } from './hub-registry'
import type { BootstrapProgress, ConnectWorkspaceInput, InitWorkspaceInput, MutagenSetupResult, WorkspaceBootstrapResult } from './hub-types'
import { BootstrapAbort, createStepRunner } from './bootstrap-steps'

export type WorkspaceBootstrapDeps = {
  stateRoot: string
  profileRoot: string
  env: NodeJS.ProcessEnv
  home: string
  hostname: string
  username: string
  devboxVersion: string
  localFacts?: LocalHostFacts
  loadProfile?: (profileId: string) => DevboxProfileV1 | undefined
  createProfile?: (input: ProfileCreateInput, options?: { keyscan?: (host: string, port: number) => Promise<readonly ScannedKey[]> }) => Promise<ProfileCreateResult>
  sshTarget: (profileId: string) => DevboxProfileSshTarget
  preflight: (profileId: string) => Promise<DevboxPreflightResult>
  pair: (profileId: string) => Promise<unknown>
  configuredDefaultProfile: () => string | undefined
  useProfile: (profileId: string) => unknown
  setProfileEnvFile: (profileId: string, path: string) => Promise<unknown>
  setProfileShellDir: (profileId: string, path: string) => Promise<unknown>
  mutagenSetup: (profileId: string, options: { remote: boolean; service: boolean }) => Promise<MutagenSetupResult>
  resolveRemoteHome?: (host: string, port: number, user: string) => Promise<string>
  register?: (target: HubRegistryTarget, facts: SpokeFacts) => Promise<unknown>
  readHub?: typeof readHub
  now?: () => Date
}

type Input = InitWorkspaceInput | ConnectWorkspaceInput

export async function runWorkspaceBootstrap(deps: WorkspaceBootstrapDeps, mode: 'init' | 'connect', input: Input, progress?: BootstrapProgress): Promise<WorkspaceBootstrapResult> {
  assertHubIsNotLocal(input.host, deps.localFacts)
  const init = mode === 'init'
  const initInput = input as InitWorkspaceInput
  const connectInput = input as ConnectWorkspaceInput
  const localRoot = init ? initInput.localRoot : connectInput.localRoot ?? join(deps.home, basename(connectInput.remoteRoot))
  const profileId = input.profileId ?? sanitizeProfileId(basename(init ? localRoot : connectInput.remoteRoot))
  let remoteRoot: string = init ? initInput.remoteRoot ?? join('/home', input.user, basename(localRoot)) : connectInput.remoteRoot
  const runner = createStepRunner(progress)
  let fingerprint: string | null = input.fingerprint ?? null
  let cachedKeys: readonly ScannedKey[] | undefined
  // Proxied hosts: one probe set (it may wake the box) serves both the dry run and the real create.
  const proxiedScan = input.proxyCommand ? { keyscan: async (host: string, port: number) => (cachedKeys ??= await scanSshKeysThroughProxy(host, port, input.user, input.proxyCommand!)) } : undefined
  let pairResult: unknown = null
  let mutagen: MutagenSetupResult | null = null
  let blocked = false
  let becameDefault = false
  try {
    await runner.run('local-root', async () => {
      if (!init && existsSync(localRoot) && !connectInput.allowNonEmptyLocal && entryCount(localRoot) > 0) {
        throw new Error(`local root is not empty: ${localRoot} (pass --allow-non-empty-local to join anyway)`)
      }
      const existed = existsSync(localRoot)
      await mkdir(localRoot, { recursive: true })
      return { detail: existed ? `exists (${entryCount(localRoot)} entries)` : 'created' }
    })
    let dryRun: ProfileCreateResult | undefined
    await runner.run('host-key', async () => {
      if (init && !initInput.remoteRoot) {
        if (deps.resolveRemoteHome) {remoteRoot = join(await deps.resolveRemoteHome(input.host, input.port, input.user), basename(localRoot))}
        else {
          cachedKeys = input.proxyCommand ? await scanSshKeysThroughProxy(input.host, input.port, input.user, input.proxyCommand) : await scanSshKeys(input.host, input.port)
          const temporary = await mkdtemp(join(tmpdir(), 'devbox-known-hosts-'))
          const knownHosts = join(temporary, 'known_hosts')
          try {
            await writeFile(knownHosts, cachedKeys.map((key) => key.line).join(''), { encoding: 'utf8', mode: 0o600 })
            const ssh = createSystemSshRunner({ host: input.host, port: input.port, username: input.user, knownHostsFile: knownHosts, ...(input.proxyCommand ? { extraOptions: proxySshOptions(input.host, input.port, input.proxyCommand) } : {}) })
            const remoteHome = (await ssh.command('printf %s "$HOME"', 10_000)).trim()
            if (!remoteHome.startsWith('/')) {throw new Error('remote home is not absolute')}
            remoteRoot = join(remoteHome, basename(localRoot))
          } finally { await rm(temporary, { recursive: true, force: true }) }
        }
      }
      const create = deps.createProfile ?? ((value: ProfileCreateInput, options?: { keyscan?: (host: string, port: number) => Promise<readonly ScannedKey[]> }) => createProfile(value, { profileRoot: deps.profileRoot, env: deps.env, ...(options?.keyscan ? { keyscan: options.keyscan } : {}) }))
      dryRun = await create({ ...profileInput(input, profileId, localRoot, remoteRoot, true), force: true }, proxiedScan)
      fingerprint = input.fingerprint ?? dryRun.fingerprints[0] ?? null
      if (!input.fingerprint && !input.yes) {throw new Error(`SSH host fingerprints: ${dryRun.fingerprints.join(', ')}; re-run with --fingerprint <one of them> or --yes`)}
      return { detail: input.fingerprint ? `pinned ${input.fingerprint}` : `accepted first scanned key ${fingerprint ?? ''}` }
    })
    await runner.run('profile', async () => {
      if (!input.force && profileExists(deps, profileId)) {throw new Error(`profile ${profileId} already exists; pass --force to replace it, or use devbox mutagen setup --profile ${profileId} for an existing profile`)}
      const create = deps.createProfile ?? ((value: ProfileCreateInput, options?: { keyscan?: (host: string, port: number) => Promise<readonly ScannedKey[]> }) => createProfile(value, { profileRoot: deps.profileRoot, env: deps.env, ...(options?.keyscan ? { keyscan: options.keyscan } : {}) }))
      const result = await create(profileInput(input, profileId, localRoot, remoteRoot, false), cachedKeys ? { keyscan: async () => cachedKeys! } : proxiedScan)
      fingerprint = result.fingerprints[0] ?? fingerprint
      return { detail: `${input.force ? 'replaced' : 'created'} ${profileId} → ${input.user}@${input.host}:${input.port}` }
    })
    const target = deps.sshTarget(profileId)
    await runner.run('remote', async () => {
      const registry: HubRegistryTarget = { ssh: target.ssh, host: input.host, port: input.port, user: input.user, remoteRoot }
      const spoke = loadOrCreateSpokeIdentity(deps.stateRoot)
      const hub = await (deps.readHub ?? readHub)(registry, spoke.spokeId)
      if (hub.reachable && hub.isSpokeRoot) {
        throw new Error(`Devbox never syncs local ↔ local: ${remoteRoot} on ${input.host} is itself a Devbox spoke root. Connect to that machine's hub instead.`)
      }
      return remoteStep(target.ssh, mode, remoteRoot, input, profileId)
    })
    await runner.run('preflight', async () => {
      const result = await deps.preflight(profileId)
      if (result.status !== 'ready') {
        blocked = true
        throw new Error(preflightDetail(result))
      }
      return { detail: 'ready' }
    })
    await runner.run('default-profile', async () => {
      const existing = deps.configuredDefaultProfile()
      if (existing === undefined) { deps.useProfile(profileId); becameDefault = true; return { detail: 'set as default' } }
      return { detail: `kept ${existing}; run: devbox profile use ${profileId}` }
    })
    if (input.envFile) {await runner.run('env-file', async () => { await deps.setProfileEnvFile(profileId, input.envFile!); return { detail: `set ${input.envFile}` } })}
    else {runner.skip('env-file', 'not requested')}
    if (input.shellDir) {await runner.run('shell-dir', async () => { await deps.setProfileShellDir(profileId, input.shellDir!); return { detail: `set ${input.shellDir}` } })}
    else {runner.skip('shell-dir', 'not requested')}
    if (input.service) {
      await runner.run('service', async () => {
        try {
          mutagen = await deps.mutagenSetup(profileId, { remote: false, service: true })
          return { status: 'ok', detail: `keepalive service installed · daemon ${mutagen.daemon.running ? 'running' : 'not running'}` }
        } catch (error) { return { status: 'warning', detail: errorMessage(error) } }
      })
    } else {runner.skip('service', 'not requested')}
    if (input.pair) {
      await runner.run('pair', async () => {
        try { pairResult = await deps.pair(profileId); return { detail: pairDetail(pairResult) } }
        catch (error) { blocked = true; throw new Error(errorMessage(error)) }
      })
    } else {
      blocked = true
      runner.skip('pair', '--no-pair: profile is saved but not syncing')
    }
    await runner.run('hub-registry', async () => {
      try {
        const spoke = loadOrCreateSpokeIdentity(deps.stateRoot)
        recordSpokeRoot(deps.stateRoot, localRoot)
        const target = deps.sshTarget(profileId)
        const facts: SpokeFacts = { spokeId: spoke.spokeId, hostname: deps.hostname, platform: process.platform, username: deps.username, localRoot, profileId, devboxVersion: deps.devboxVersion }
        const result = await (deps.register ?? ((registry, value) => registerHubAndSpoke(registry, value)))({ ssh: target.ssh, host: input.host, port: input.port, user: input.user, remoteRoot }, facts)
        const spokes = isHubView(result) ? result.spokes.length : 0
        return { detail: `hub ${hubIdForRoot(remoteRoot)} · ${spokes} spoke(s)` }
      } catch (error) { return { status: 'warning', detail: `${errorMessage(error)} · run: devbox mutagen setup --profile ${profileId}` } }
    })
  } catch (error) {
    if (error instanceof BootstrapAbort) {
      blocked ||= error.step.id === 'preflight' || error.step.id === 'pair'
    } else {throw error}
  }
  const steps = runner.steps()
  const failed = steps.some((step) => step.status === 'failed')
  const status = failed ? blocked ? 'blocked' : 'failed' : blocked ? 'blocked' : 'ready'
  const defaulted = becameDefault || deps.configuredDefaultProfile() === profileId
  const profileFlag = defaulted ? '' : ` --profile ${profileId}`
  const preflightBlocked = steps.some((step) => step.id === 'preflight' && step.status === 'failed')
  const nextSteps = status === 'ready'
    ? [`devbox status${profileFlag}`, `devbox shell${profileFlag}`, `devbox mutagen status${profileFlag}`, ...(mode === 'connect' ? [`The first sync pulls the hub into ${localRoot}; watch progress with devbox status`] : [])]
    : preflightBlocked
      ? [`devbox preflight${profileFlag} --json`, `fix the blockers, then: devbox pair${profileFlag}`, `devbox mutagen setup${profileFlag}`]
      : blocked ? [`devbox pair${profileFlag}`] : []
  return { mode, profileId, host: input.host, port: input.port, user: input.user, localRoot, remoteRoot, fingerprint, steps: runner.steps(), status, pair: pairResult, mutagen, nextSteps }
}

export function sanitizeProfileId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 64)
  if (sanitized.length === 0 || !/^[A-Za-z0-9]/u.test(sanitized)) {return 'devbox'}
  return sanitized
}

function profileInput(input: Input, profileId: string, localRoot: string, remoteRoot: string, dryRun: boolean): ProfileCreateInput {
  return { profileId, host: input.host, port: input.port, username: input.user, localRoot, remoteRoot, fingerprint: input.fingerprint, ...(input.proxyCommand ? { proxyCommand: input.proxyCommand } : {}), yes: input.yes, force: input.force, dryRun }
}

function profileExists(deps: WorkspaceBootstrapDeps, profileId: string): boolean {
  try { return deps.loadProfile?.(profileId) !== undefined } catch { return false }
}
function entryCount(path: string): number { try { return readdirSync(path).length } catch { return 0 } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function preflightDetail(result: DevboxPreflightResult): string { const blockers = result.blockers.map((item) => item.id).join(', ') || 'unknown'; const remediation = result.blockers[0]?.remediation ?? 'resolve the preflight blockers'; return `preflight blocked (${blockers}): ${remediation}` }
function pairDetail(value: unknown): string { if (!value || typeof value !== 'object') {return 'pair complete';} const item = value as { state?: unknown; sessions?: unknown; sessionCount?: unknown }; return `${typeof item.state === 'string' ? item.state : 'pair complete'}${typeof item.sessions === 'number' ? ` · ${item.sessions} session(s)` : typeof item.sessionCount === 'number' ? ` · ${item.sessionCount} session(s)` : ''}` }
function isHubView(value: unknown): value is { spokes: readonly unknown[] } { return typeof value === 'object' && value !== null && 'spokes' in value && Array.isArray((value as { spokes?: unknown }).spokes) }

async function remoteStep(ssh: DevboxSshRunner, mode: 'init' | 'connect', root: string, input: Input, profileId: string): Promise<{ status?: 'warning'; detail: string }> {
  const quotedRoot = shell(root)
  const adoptRemote = mode === 'init' && (input as InitWorkspaceInput).adoptRemote
  // Probe the remote OS once, separately, so the mkdir/tmux/service script sent to a
  // darwin hub never contains the loginctl/systemctl commands at all (a macOS hub has
  // no systemd user manager or linger; those are Linux-only concepts).
  const platformProbe = (await ssh.command('uname -s', 15_000).catch(() => '')).trim()
  const darwinHub = platformProbe === 'Darwin'
  const osLine = `printf 'OS=%s\\n' ${shell(platformProbe || 'unknown')}`
  const serviceProbe = darwinHub
    ? `printf 'LINGER=n/a\\n'
printf 'SUDO=%s\\n' "$(sudo -n true >/dev/null 2>&1 && echo yes || echo no)"
printf 'USERMGR=launchd\\n'`
    : `printf 'LINGER=%s\\n' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
printf 'SUDO=%s\\n' "$(sudo -n true >/dev/null 2>&1 && echo yes || echo no)"
printf 'USERMGR=%s\\n' "$(systemctl --user is-system-running 2>/dev/null || echo unknown)"`
  const script = `set -eu
profile_id=${shell(profileId)}
state_root="$HOME/.local/state/devbox/$profile_id"
${mode === 'init'
    ? `if [ -f ${quotedRoot} ]; then echo REMOTE-FILE; exit 41; fi
if [ -d ${quotedRoot} ] && [ "$(ls -A ${quotedRoot} 2>/dev/null | sed -n '1p')" ] && [ "${adoptRemote ? 'yes' : 'no'}" != yes ]; then echo REMOTE-NONEMPTY; exit 42; fi
mkdir -p ${quotedRoot} "$state_root"`
    : `if [ ! -d ${quotedRoot} ]; then echo HUB-MISSING; exit 43; fi
mkdir -p "$state_root"`}
${osLine}
printf 'TMUX=%s\\n' "$(command -v tmux >/dev/null 2>&1 && echo yes || echo no)"
${serviceProbe}`
  try {
    const output = await ssh.script(script, 120_000)
    if (output.includes('REMOTE-NONEMPTY') || output.includes('HUB-MISSING') || output.includes('REMOTE-FILE')) {throw new Error(output)}
    const values = Object.fromEntries(output.split(/\r?\n/u).flatMap((line) => { const match = /^(OS|TMUX|LINGER|SUDO|USERMGR)=(.*)$/u.exec(line); return match ? [[match[1]!, match[2]!]] : [] }))
    let status: 'warning' | undefined
    const warnings: string[] = []
    let tmux = values.TMUX ?? 'unknown'
    if (tmux !== 'yes') {
      const timedSsh: DevboxSshRunner = { command: (command, timeoutMs = 60_000) => ssh.command(command, timeoutMs), script: (value, timeoutMs = 60_000) => ssh.script(value, timeoutMs) }
      try { await ensureDevboxTmux(timedSsh, () => undefined); tmux = 'yes' }
      catch (error) { tmux = 'warning'; status = 'warning'; warnings.push(`tmux: ${errorMessage(error)}`) }
    }
    let linger = values.LINGER ?? 'unknown'
    const darwin = values.OS === 'Darwin'
    const lingerCommand = 'sudo -n loginctl enable-linger "$USER"'
    if (!darwin && linger !== 'yes') {
      if (values.SUDO === 'yes') {
        const timedCommand = (command: string): Promise<string> => ssh.command(command, 60_000)
        try { await timedCommand(lingerCommand); linger = 'enabled' }
        catch (error) { status = 'warning'; warnings.push(`linger: ${errorMessage(error)} · run: ${lingerCommand}`) }
      } else { status = 'warning'; warnings.push(`linger unavailable · run: ${lingerCommand}`) }
    }
    return { ...(status ? { status } : {}), detail: [`root ${mode === 'init' ? 'created' : 'found'}`, `tmux ${tmux}`, `linger ${linger}`, values.USERMGR ?? 'systemd --user unknown', ...(darwin ? ['macOS hub: detached jobs unsupported'] : []), ...warnings].join(' · ') }
  } catch (error) {
    const detail = errorMessage(error)
    if (detail.includes('REMOTE-NONEMPTY') || /remote root is not empty|remote root non-empty/i.test(detail)) {throw new Error(`remote root is not empty: ${root} on ${input.host} (use devbox connect to join it as a spoke, or --adopt-remote)`)}
    if (detail.includes('HUB-MISSING') || /hub root not found/i.test(detail)) {throw new Error(`hub root not found: ${root} on ${input.host}; run devbox init from the machine that holds the files`)}
    if (detail.includes('REMOTE-FILE') || /remote root is a file/i.test(detail)) {throw new Error(`remote root is a file: ${root} on ${input.host}`)}
    throw error
  }
}

function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

async function scanSshKeys(host: string, port: number): Promise<readonly ScannedKey[]> {
  const result = await commandExecFileAsync('ssh-keyscan', ['-T', '10', '-p', String(port), host])
  const keys = result.stdout.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 3 || fields[0]!.startsWith('#')) {return []}
    return [{ type: fields[1]!, blob: Buffer.from(fields[2]!, 'base64'), line: `${fields[0]} ${fields[1]} ${fields[2]}\n` }]
  })
  if (keys.length === 0) {throw new Error('SSH host key scan returned no keys')}
  return keys
}
