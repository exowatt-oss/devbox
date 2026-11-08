import { spawn } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import { DEVBOX_DEFAULT_MAX_ENTRY_COUNT, DEVBOX_GIT_ROAMING_EXCLUSIONS, DEVBOX_PROFILE_SCHEMA_VERSION, type DevboxProfileV1 } from '../shared/devbox-types'
import { defaultDevboxGitRoamingConfig } from '../core/devbox-profile-store'
import { fingerprintSshSha256 } from '../ssh/known-hosts'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { validateIgnorePattern } from './profile-ignore'
import { normalizeDevboxProxyCommand } from '../ssh/ssh-proxy'
import { scanSshKeysThroughProxy } from './ssh-proxy-keyscan'

export type ProfileCreateInput = {
  profileId: string
  host: string
  port: number
  username: string
  localRoot: string
  remoteRoot: string
  fingerprint?: string
  /** Optional OpenSSH ProxyCommand; host keys are then read through it, not with ssh-keyscan. */
  proxyCommand?: string
  yes: boolean
  force: boolean
  gitRoaming?: boolean
  dryRun?: boolean
  ignore?: readonly string[]
}

export type ProfileCreateResult = {
  profile: DevboxProfileV1
  fingerprints: readonly string[]
  knownHostsFile: string
  dryRun?: boolean
  inventory?: unknown
}

export type ScannedKey = { type: string; blob: Buffer; line: string }
export type ProfileKeyscan = (host: string, port: number, proxy?: { proxyCommand: string; username: string }) => Promise<readonly ScannedKey[]>

export async function createProfile(
  input: ProfileCreateInput,
  options: {
    profileRoot: string
    env: NodeJS.ProcessEnv
    keyscan?: ProfileKeyscan
    roamingPreflight?: (profile: DevboxProfileV1, keys: readonly ScannedKey[]) => Promise<unknown>
  }
): Promise<ProfileCreateResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profileId)) {
    throw cliDevboxError('operation_conflict', 'profile-id')
  }
  if ((input.ignore?.length ?? 0) > 0 && !input.gitRoaming) {
    throw cliDevboxError('operation_conflict', 'ignore-requires-git-roaming', 'The --ignore flag requires --git-roaming.')
  }
  const profileStore = new DevboxProfileStore({ rootDir: options.profileRoot, env: options.env })
  const target = join(options.profileRoot, input.profileId)
  const knownHostsFile = join(target, 'known_hosts')
  const profilePath = join(options.profileRoot, `${input.profileId}.json`)
  if (existsSync(profilePath) && !input.force) {
    throw cliDevboxError('operation_conflict', 'profile-overwrite')
  }
  if (!isAbsolute(input.localRoot) || !isAbsolute(input.remoteRoot)) {
    throw cliDevboxError('operation_conflict', 'absolute-roots')
  }
  const proxyCommand = input.proxyCommand === undefined ? undefined : normalizeProxyCommand(input.proxyCommand)
  const keys = await (options.keyscan ?? defaultKeyscan)(input.host, input.port, proxyCommand === undefined ? undefined : { proxyCommand, username: input.username })
  const fingerprints = [...new Set(keys.map((entry) => fingerprintSshSha256(entry.blob)))]
  if (input.fingerprint && !fingerprints.includes(input.fingerprint)) {
    throw cliDevboxError('ssh_identity_mismatch', 'host-key-fingerprint')
  }
  if (!input.fingerprint && !input.yes) {
    throw cliDevboxError(
      'ssh_identity_mismatch',
      'host-key-acceptance',
      `SSH host fingerprints: ${fingerprints.join(', ')}. Re-run with --yes to accept.`
    )
  }
  if (fingerprints.length === 0) {
    throw cliDevboxError('ssh_identity_mismatch', 'host-key-scan-empty')
  }
  const selectedFingerprint = input.fingerprint ?? fingerprints[0]!
  const profile = makeProfile({ ...input, proxyCommand }, selectedFingerprint)
  if (input.dryRun) {
    // Dry-run is deliberately side-effect free: no profile directory, known-hosts
    // file, marker, or workspace byte is created. Inventory is attached by the
    // CLI/service preflight layer when the roots are available.
    return { profile, fingerprints, knownHostsFile, dryRun: true, ...(input.gitRoaming && options.roamingPreflight ? { inventory: await options.roamingPreflight(profile, keys) } : {}) }
  }
  mkdirSync(target, { recursive: true, mode: 0o700 })
  await writeKnownHosts(knownHostsFile, keys)
  const saved = profileStore.saveProfile(profile)
  if (saved.status !== 'saved') {
    throw 'error' in saved ? saved.error : createDevboxError('profile_malformed')
  }
  return { profile: saved.profile, fingerprints, knownHostsFile }
}

function cliDevboxError(
  code: 'operation_conflict' | 'ssh_identity_mismatch',
  field: string,
  message?: string
): DevboxError {
  const error = createDevboxError(code, { context: { field } })
  return message ? { ...error, message } : error
}

function makeProfile(input: ProfileCreateInput, hostKeyFingerprint: string): DevboxProfileV1 {
  const ignore = [...new Set((input.ignore ?? []).map(validateIgnorePattern))]
  const classes = [
    ['portable-working', 'portable-working', 'mutagen', 'two-way-safe'],
    ['portable-declarative', 'portable-declarative', 'mutagen', 'two-way-safe'],
    ['git-durable', 'git-durable', 'rsync-fallback', 'checkpoint-only'],
    ['session-durable', 'session-durable', 'rsync-fallback', 'authority-only'],
    ['generated', 'generated', 'rsync-fallback', 'rebuild-on-host'],
    ['credentials', 'credentials', 'rsync-fallback', 'broker-only'],
    ['stateful-service', 'stateful-service', 'rsync-fallback', 'host-local'],
    ['unsupported', 'unsupported', 'rsync-fallback', 'excluded']
  ].map(([id, kind, backend, mode]) => ({ id, kind, backend, mode, excludes: [] })) as DevboxProfileV1['sync']['classes']
  return {
    schemaVersion: DEVBOX_PROFILE_SCHEMA_VERSION,
    id: input.profileId,
    displayName: input.profileId,
    sshTarget: {
      targetId: `devbox-${input.profileId}`,
      identity: {
        host: input.host,
        port: input.port,
        username: input.username,
        hostKeyFingerprint
      },
      ...(input.proxyCommand === undefined ? {} : { proxyCommand: input.proxyCommand })
    },
    roots: { localRoot: input.localRoot, remoteRoot: input.remoteRoot },
    pathMap: [{ id: 'workspace', localRelativePath: '.', remoteRelativePath: '.', syncClassId: 'portable-working' }],
    toolchain: { lockId: 'devbox-default', lockSha256: '0'.repeat(64) },
    sync: {
      classes: classes.map((item) => item.id === 'portable-working' && input.gitRoaming
        ? { ...item, excludes: [...DEVBOX_GIT_ROAMING_EXCLUSIONS, ...ignore] }
        : item),
      defaultClassId: 'portable-working',
      excludes: input.gitRoaming ? [...DEVBOX_GIT_ROAMING_EXCLUSIONS, ...ignore] : [],
      maxEntryCount: DEVBOX_DEFAULT_MAX_ENTRY_COUNT
    },
    gitRoaming: input.gitRoaming ? {
      ...defaultDevboxGitRoamingConfig(),
      enabled: true,
      ignorePatterns: ignore.map((pattern) => ({ pattern, rootClass: 'portable-working' }))
    } : defaultDevboxGitRoamingConfig(),
    credentials: [{
      kind: 'ssh-transport', referenceId: 'ssh-transport',
      targetId: `devbox-${input.profileId}`, delivery: 'devbox-managed'
    }],
    defaultAuthority: 'local',
    projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: false },
    featureDefaults: { detachedJobs: true, closedSessionHistory: true },
    slo: {
      syncLagTargetMs: 10_000, reconnectTargetMs: 30_000,
      operationRecoveryTargetMs: 60_000, offlineEdits: 'warn'
    }
  }
}

function normalizeProxyCommand(value: string): string {
  try { return normalizeDevboxProxyCommand(value) } catch (error) {
    throw cliDevboxError('operation_conflict', 'proxy-command', error instanceof Error ? error.message : String(error))
  }
}

function defaultKeyscan(host: string, port: number, proxy?: { proxyCommand: string; username: string }): Promise<readonly ScannedKey[]> {
  return proxy ? scanSshKeysThroughProxy(host, port, proxy.username, proxy.proxyCommand) : sshKeyscan(host, port)
}

function sshKeyscan(host: string, port: number): Promise<ScannedKey[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-keyscan', ['-T', '10', '-p', String(port), host], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(cliDevboxError('ssh_identity_mismatch', 'ssh-keyscan-timeout'))
    }, 15_000)
    child.once('error', () => {
      clearTimeout(timer)
      reject(cliDevboxError('ssh_identity_mismatch', 'ssh-keyscan'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !stdout.trim()) {
        reject(cliDevboxError('ssh_identity_mismatch', 'ssh-keyscan'))
        return
      }
      resolve(stdout.split(/\r?\n/u).flatMap(parseKeyscanLine))
    })
  })
}

function parseKeyscanLine(line: string): ScannedKey[] {
  const fields = line.trim().split(/\s+/u)
  if (fields.length < 3 || fields[0]!.startsWith('#')) {return []}
  return [{
    type: fields[1]!,
    blob: Buffer.from(fields[2]!, 'base64'),
    line: `${fields[0]} ${fields[1]} ${fields[2]}\n`
  }]
}

async function writeKnownHosts(path: string, keys: readonly ScannedKey[]): Promise<void> {
  await writeFile(path, keys.map((key) => key.line).join(''), { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}
