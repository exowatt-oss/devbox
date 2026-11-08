import { randomBytes } from 'node:crypto'
import { validateDevboxRunArgs } from '../shared/devbox-ipc'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type { DevboxProfileSelection } from './profile-resolution'
import { CliArgumentError } from './args'
import { getOptionalNonNegativeIntegerFlag, getOptionalStringFlag, getRepeatedStringFlag, getRequiredPortFlag, getRequiredStringFlag } from './flags'
import type { DevboxServiceLike } from './operations'
import { DEVBOX_BLOCKED_OPERATIONS, DevboxBlockedError, operationKey } from './operations'
import { formatDevboxStage, printDevboxResult } from './format'
import { createPresentation, type PresentationOptions } from './presentation'
import { handleShell } from './shell-handler'
import { handleSyncNow } from './sync-now-handler'
import { resolveDevboxEnvFilePath } from './profile-preferences'
import { runWithCancellation } from './run-cancellation'
import { DEVBOX_PROFILE_CREDENTIAL_HANDLERS } from './profile-credentials-handlers'
import { DEVBOX_PROFILE_PASTE_HANDLERS } from './profile-paste-handlers'
import { DEVBOX_PROFILE_CREATE_HANDLERS } from './profile-create-handler'
import { DEVBOX_PROFILE_WATCH_POLLING_HANDLERS } from './profile-watch-polling-handlers'
import { DEVBOX_PROFILE_PROXY_COMMAND_HANDLERS } from './profile-proxy-command'
import { DEVBOX_MUTAGEN_HANDLERS } from './mutagen-handlers'
import { DEVBOX_DEVICE_HANDLERS } from './device-handlers'
import { DEVBOX_WORKSPACE_HANDLERS } from './workspace-handlers'

export type HandlerContext = {
  flags: Map<string, string | boolean>
  service: DevboxServiceLike
  cwd: string
  json: boolean
  profile?: DevboxProfileV1
  profileSelection?: DevboxProfileSelection
  positionalArgs?: string[]
  rawArgs?: string[]
  holdForeground?: () => Promise<void>
  presentation?: PresentationOptions
}
export type CommandHandler = (ctx: HandlerContext) => Promise<void>

export const DEVBOX_HANDLERS: Record<string, CommandHandler> = {
  pair: async ({ flags, service, json }) => {
    const profileId = profile(flags)
    assertNoTakeover(flags, profileId)
    const value = await service.start(profileId)
    printResult('pair', 'pair', value, flags, json)
  },
  status: async ({ flags, service, json }) => {
    const profileId = profile(flags)
    const value = await service.status(profileId)
    printResult('status', 'status', value, flags, json)
  },
  disable: async ({ flags, service, json }) => {
    const profileId = profile(flags)
    const value = await service.disable(profileId)
    printResult('disable', 'disable', value, flags, json)
  },
  sync: handleSyncNow,
  shell: handleShell,
  phi: async ({ flags, service, json }) => {
    const profileId = profile(flags)
    const args = {
      localPath: getRequiredStringFlag(flags, 'path'),
      sessionId: getRequiredStringFlag(flags, 'session-id'),
      relayEpoch: getRequiredStringFlag(flags, 'relay-epoch')
    }
    const value = await service.launchPhi(profileId, args.localPath, args.sessionId, args.relayEpoch)
    printResult('phi', 'phi', value, flags, json)
  },
  run: async ({ flags, service, profile: selectedProfile, rawArgs, json }) => {
    const profileId = profile(flags)
    const id = getOptionalStringFlag(flags, 'id') ?? generateDevboxJobId()
    const cwd = getOptionalStringFlag(flags, 'cwd') ?? selectedProfile?.roots.remoteRoot
    if (!cwd) {
      throw new CliArgumentError('devbox run could not determine a remote cwd; pass --cwd <path>.')
    }
    const job = {
      id,
      command: commandArg(rawArgs, flags) ?? [],
      cwd,
      environment: parseEnvironment(flags),
      detached: true as const
    }
    const validation = validateDevboxRunArgs({ profileId, job })
    if (!validation.ok) {
      throw new CliArgumentError(`Invalid devbox run argument: ${validation.field}`)
    }
    let existing: unknown = null
    try {
      existing = await service.jobStatus(profileId, job.id)
    } catch {
      // A missing job record means this invocation owns the launch.
    }
    const attach = flags.get('attach') === true
    const value = existing
      ? { job: attach ? await waitForJob(service, profileId, job.id) : existing, attached: true }
      : await runWithCancellation(service, profileId, validation.value.job, attach, waitForJob, asRecord)
    let status: unknown = null
    try {
      status = await service.status(profileId)
    } catch {
      // The detached result remains authoritative if the follow-up status races shutdown.
    }
    const statusRecord = asRecord(status)
    const result = {
      ...asRecord(value),
      ...(typeof statusRecord.generationId === 'string' ? { generationId: statusRecord.generationId } : {})
    }
    printResult('run', 'run', result, flags, json)
  },
  git: async ({ flags, service, rawArgs, json }) => {
    const argv = rawArgs ?? []
    if (argv.length === 0) {
      throw new CliArgumentError('devbox git requires argv after --.')
    }
    const localPath = getOptionalStringFlag(flags, 'path')
    if (!localPath) {
      throw new CliArgumentError('devbox git requires --path; refusing an ambiguous or unmapped root.')
    }
    const value = service.git
      ? await service.git(profile(flags), localPath, argv)
      : await service.launchTerminal(profile(flags), localPath, 'terminal', ['git', ...argv])
    printResult('git', 'git', value, flags, json)
  },
  'jobs status': async ({ flags, service, json }) => {
    const profileId = profile(flags)
    const value = await service.jobStatus(profileId, getRequiredStringFlag(flags, 'job-id'))
    printResult('jobs status', 'jobs.status', value, flags, json)
  },
  'jobs cancel': async ({ flags, service, json }) => {
    const profileId = profile(flags)
    const value = await service.cancelJob(profileId, getRequiredStringFlag(flags, 'job-id'))
    printResult('jobs cancel', 'jobs.cancel', value, flags, json)
  },
  'jobs log': async ({ flags, service, json }) => {
    const value = await service.tailJobLog(
      profile(flags),
      getRequiredStringFlag(flags, 'job-id'),
      getOptionalNonNegativeIntegerFlag(flags, 'offset') ?? 0,
      getOptionalNonNegativeIntegerFlag(flags, 'limit') ?? 64 * 1024
    )
    printResult('jobs log', 'jobs.log', value, flags, json)
  },
  'ports open': async ({ flags, service, json, holdForeground }) => {
    const remotePort = getRequiredPortFlag(flags, 'remote-port')
    const value = await service.openPort(
      profile(flags),
      remotePort,
      flags.get('public') === true,
      getOptionalStringFlag(flags, 'label')
    )
    printResult('ports open', 'ports.open', value, flags, json)
    if (holdForeground) {
      await holdForeground()
    }
  },
  'profile list': async ({ service, flags, json }) => {
    printResult('profile list', 'profile.list', service.listProfiles(), flags, json)
  },
  'profile use': async ({ flags, service, positionalArgs, json }) => {
    const requested = positionalArgs ?? []
    const clear = flags.get('clear') === true
    if (clear && requested.length > 0) {
      throw new CliArgumentError('devbox profile use accepts either <id> or --clear, not both.')
    }
    if (!clear && requested.length !== 1) {
      throw new CliArgumentError('Usage: devbox profile use <id> | --clear')
    }
    const value = service.useProfile(clear ? undefined : requested[0])
    printResult('profile use', 'profile.use', value, flags, json)
  },
  'profile env-file': async ({ flags, service, json }) => {
    if (flags.get('clear') !== true) { throw new CliArgumentError('Usage: devbox profile env-file --clear') }
    const value = await service.setProfileEnvFile(profile(flags), undefined)
    printResult('profile env-file', 'profile.env-file.clear', value, flags, json)
  },
  'profile env-file set': async ({ flags, service, positionalArgs, cwd, json }) => {
    const requested = positionalArgs ?? []
    const clear = flags.get('clear') === true
    if (clear && requested.length > 0) { throw new CliArgumentError('devbox profile env-file set accepts either <path> or --clear, not both.') }
    if (!clear && requested.length !== 1) { throw new CliArgumentError('Usage: devbox profile env-file set <path> | --clear') }
    const envFile = clear ? undefined : resolveDevboxEnvFilePath(requested[0]!, cwd)
    const value = await service.setProfileEnvFile(profile(flags), envFile)
    printResult('profile env-file set', 'profile.env-file.set', value, flags, json)
  },
  'profile env-file show': async ({ flags, service, json }) => { const value = service.showProfileEnvFile(profile(flags)); printResult('profile env-file show', 'profile.env-file.show', value, flags, json) },
  'profile shell-dir': async ({ flags, service, json, positionalArgs }) => {
    if (flags.get('clear') !== true || (positionalArgs ?? []).length > 0) { throw new CliArgumentError('Usage: devbox profile shell-dir --clear') }
    const value = await service.setProfileShellDir(profile(flags), undefined)
    printResult('profile shell-dir', 'profile.shell-dir.clear', value, flags, json)
  },
  'profile shell-dir set': async ({ flags, service, positionalArgs, json }) => {
    const requested = positionalArgs ?? []
    const clear = flags.get('clear') === true
    if (clear && requested.length > 0) { throw new CliArgumentError('devbox profile shell-dir set accepts either <remote-dir> or --clear, not both.') }
    if (!clear && requested.length !== 1) { throw new CliArgumentError('Usage: devbox profile shell-dir set <remote-dir> | --clear') }
    const value = await service.setProfileShellDir(profile(flags), clear ? undefined : requested[0])
    printResult('profile shell-dir set', 'profile.shell-dir.set', value, flags, json)
  },
  'profile shell-dir show': async ({ flags, service, json }) => { const value = service.showProfileShellDir(profile(flags)); printResult('profile shell-dir show', 'profile.shell-dir.show', value, flags, json) },
  'profile device': async ({ flags, service, json, positionalArgs }) => { if (flags.get('clear') !== true || (positionalArgs ?? []).length > 0) { throw new CliArgumentError('Usage: devbox profile device --clear') }; const value = service.setProfileDevice(profile(flags), undefined); printResult('profile device', 'profile.device.clear', value, flags, json) },
  'profile device set': async ({ flags, service, positionalArgs, json }) => { const requested = positionalArgs ?? []; if (requested.length !== 1) { throw new CliArgumentError('Usage: devbox profile device set <alias>') }; const value = service.setProfileDevice(profile(flags), requested[0]); printResult('profile device set', 'profile.device.set', value, flags, json) },
  'profile device show': async ({ flags, service, json, positionalArgs }) => { if ((positionalArgs ?? []).length > 0) { throw new CliArgumentError('Usage: devbox profile device show') }; const value = service.showProfileDevice(profile(flags)); printResult('profile device show', 'profile.device.show', value, flags, json) },
  'profile sync-max-entry-count': async ({ flags, service, positionalArgs, json }) => { if (flags.get('clear') !== true || (positionalArgs ?? []).length > 0) { throw new CliArgumentError('Usage: devbox profile sync-max-entry-count --clear') }; const value = await service.setProfileMaxEntryCount(profile(flags), undefined); printResult('profile sync-max-entry-count', 'profile.sync-max-entry-count.clear', value, flags, json) },
  'profile sync-max-entry-count set': async ({ flags, service, positionalArgs, json }) => { const requested = positionalArgs ?? []; if (requested.length !== 1) { throw new CliArgumentError('Usage: devbox profile sync-max-entry-count set <count>') }; const maxEntryCount = Number(requested[0]); if (!Number.isSafeInteger(maxEntryCount) || maxEntryCount < 1) { throw new CliArgumentError('<count> must be a positive safe integer.') }; const value = await service.setProfileMaxEntryCount(profile(flags), maxEntryCount); printResult('profile sync-max-entry-count set', 'profile.sync-max-entry-count.set', value, flags, json) },
  'profile sync-max-entry-count show': async ({ flags, service, positionalArgs, json }) => { if ((positionalArgs ?? []).length > 0) { throw new CliArgumentError('Usage: devbox profile sync-max-entry-count show') }; const value = service.showProfileMaxEntryCount(profile(flags)); printResult('profile sync-max-entry-count show', 'profile.sync-max-entry-count.show', value, flags, json) },
  'profile ignore add': async ({ flags, service, positionalArgs, json }) => { const patterns = positionalArgs ?? []; if (patterns.length === 0) {throw new CliArgumentError('Usage: devbox profile ignore add <pattern...> [--root-class <class>]')}; const value = await service.addProfileIgnores(profile(flags), patterns, getOptionalStringFlag(flags, 'root-class')); printResult('profile ignore add', 'profile.ignore.add', value, flags, json) },
  'profile ignore list': async ({ flags, service, positionalArgs, json }) => { if ((positionalArgs ?? []).length > 0) {throw new CliArgumentError('Usage: devbox profile ignore list')}; const value = service.listProfileIgnores(profile(flags)); printResult('profile ignore list', 'profile.ignore.list', value, flags, json) },
  'profile ignore rm': async ({ flags, service, positionalArgs, json }) => { const patterns = positionalArgs ?? []; if (patterns.length === 0) {throw new CliArgumentError('Usage: devbox profile ignore rm <pattern...>')}; const value = await service.removeProfileIgnores(profile(flags), patterns); printResult('profile ignore rm', 'profile.ignore.rm', value, flags, json) },
  ...DEVBOX_PROFILE_CREDENTIAL_HANDLERS,
  ...DEVBOX_PROFILE_PASTE_HANDLERS,
  ...DEVBOX_PROFILE_CREATE_HANDLERS,
  ...DEVBOX_PROFILE_WATCH_POLLING_HANDLERS,
  ...DEVBOX_PROFILE_PROXY_COMMAND_HANDLERS,
  ...DEVBOX_MUTAGEN_HANDLERS,
  ...DEVBOX_DEVICE_HANDLERS,
  ...DEVBOX_WORKSPACE_HANDLERS,
  handoff: async ({ flags, service, json }) => {
    const target = getRequiredStringFlag(flags, 'to')
    if (target !== 'local' && target !== 'remote') {
      throw new CliArgumentError('--to must be local or remote.')
    }
    if (!service.handoff) {throw new CliArgumentError('Git roaming handoff is unavailable in this service.')}
    const value = await service.handoff(profile(flags), target)
    printResult('handoff', 'handoff', value, flags, json)
  },
  preflight: async ({ flags, service, json, presentation }) => {
    const value = await service.preflight(profile(flags))
    printDevboxPreflight(value, json, presentation)
    if (value.status !== 'ready') {process.exitCode = 1}
  },
  ...blockedHandlers()
}

function printResult(command: string, operation: string, value: unknown, flags: Map<string, string | boolean>, json: boolean): void {
  printDevboxResult(command, operation, value, operationKey(operation, value, getOptionalStringFlag(flags, 'operation-key')), json, formatDevboxStage)
}

function printDevboxPreflight(value: unknown, json: boolean, options?: PresentationOptions): void {
  // Keep JSON on the raw service path: presentation must never style or reshape it.
  if (json) {console.log(JSON.stringify(value, null, 2)); return}
  const result = value as { status?: string; blockedReason?: string; blockers?: readonly { id: string; remediation: string }[] }
  const status = result.status === 'ready' || result.status === 'blocked' || result.status === 'cancelled' ? result.status : 'unknown'
  const presentation = createPresentation(options ?? { output: process.stdout, env: process.env }); const statusKind = status === 'ready' ? 'success' : status === 'blocked' ? 'error' : status === 'cancelled' ? 'warning' : 'muted'
  const reason = result.blockedReason ?? (status === 'ready' ? 'all checks passed' : status === 'cancelled' ? 'cancelled by user' : 'unknown')
  const lines = [presentation.title('Devbox preflight'), `Status: ${presentation.status(statusKind, status.toUpperCase())}`, `Reason: ${reason}`]; const blockers = result.blockers ?? []
  if (blockers.length > 0) {
    lines.push('', presentation.section('Blockers'), presentation.table({ rows: blockers, columns: [{ header: 'ID', get: (blocker: { id: string }) => blocker.id, priority: 3, minWidth: 2 }, { header: 'REMEDIATION', get: (blocker: { remediation: string }) => blocker.remediation, priority: 2, minWidth: 1 }], gap: 2 } as never))
  } else { const message = status === 'ready' ? 'No blockers.' : status === 'cancelled' ? 'No blockers recorded before cancellation.' : status === 'blocked' ? 'No blockers were reported.' : 'No blocker details were reported.'; lines.push('', presentation.emptyState(message)) }
  console.log(lines.join('\n'))
}

function blockedHandlers(): Record<string, CommandHandler> {
  return Object.fromEntries(DEVBOX_BLOCKED_OPERATIONS.map((operation) => [
    operation.command,
    async () => { throw new DevboxBlockedError(operation) }
  ]))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function profile(flags: Map<string, string | boolean>): string {
  return getRequiredStringFlag(flags, 'profile')
}

export function generateDevboxJobId(now = new Date(), random = randomBytes(2)): string {
  const timestamp = `${now.getUTCFullYear().toString().padStart(4, '0')}${
    (now.getUTCMonth() + 1).toString().padStart(2, '0')
  }${now.getUTCDate().toString().padStart(2, '0')}-${now.getUTCHours().toString().padStart(2, '0')}${
    now.getUTCMinutes().toString().padStart(2, '0')
  }${now.getUTCSeconds().toString().padStart(2, '0')}`
  return `job-${timestamp}-${random.toString('hex').slice(0, 4)}`
}

function commandArg(rawArgs: readonly string[] | undefined, flags: Map<string, string | boolean>): string[] | undefined {
  if (rawArgs && rawArgs.length > 0) {return [...rawArgs]}
  const command = getOptionalStringFlag(flags, 'command')
  return command === undefined ? undefined : [command]
}

function parseEnvironment(flags: Map<string, string | boolean>): Record<string, string> | undefined {
  const entries = getRepeatedStringFlag(flags, 'env')
  if (entries.length === 0) {return undefined}
  const environment: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {throw new CliArgumentError('--env values must use KEY=VALUE.')}
    environment[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return environment
}

async function waitForJob(service: DevboxServiceLike, profileId: string, jobId: string): Promise<unknown> {
  if (!service.waitForJob) {
    throw new CliArgumentError('Attached run is unavailable in this service.')
  }
  return service.waitForJob(profileId, jobId)
}

function assertNoTakeover(flags: Map<string, string | boolean>, profileId: string): void {
  const force = flags.get('force') === true
  const yes = flags.get('yes') === true
  const confirmation = getOptionalStringFlag(flags, 'confirm')
  if (!force && !yes && confirmation === undefined) {return}
  if (!force || confirmation !== `TAKE OVER ${profileId}`) {
    throw new CliArgumentError(`A force takeover requires --confirm "TAKE OVER ${profileId}"; --yes never bypasses typed confirmation.`)
  }
  throw new CliArgumentError('Force takeover is unavailable in the frozen T-006 IPC; no takeover authority was invoked.')
}
