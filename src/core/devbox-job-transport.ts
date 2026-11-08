import { shellEscape } from '../ssh/shell-escape'
import { devboxCredentialEnvRemotePath, stageDevboxCredentialEnv } from './devbox-credential-env'
import { createDevboxError } from '../shared/devbox-errors'
import type {
  DevboxJobSpec,
  DevboxJobTransport as DevboxJobTransportContract,
  DevboxRemoteJob,
  DevboxRemoteJobCreateRequest
} from './devbox-job-supervisor'
import type { DevboxJobLogStore } from './devbox-job-logs'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const TERMINAL = new Set<DevboxRemoteJob['status']>(['completed', 'failed', 'cancelled'])

type JobTransportOptions = {
  runner: DevboxSshRunner
  profileId: string
  remoteStateRoot?: string
  waitPollMs?: number
  waitTimeoutMs?: number
  logs?: DevboxJobLogStore
  envFilePath?: string; envFilePathForRun?: () => string | undefined
}

export class DevboxJobTransport implements DevboxJobTransportContract {
  private readonly runner: DevboxSshRunner
  private readonly profileId: string
  private readonly root: string
  private readonly waitPollMs: number
  private readonly waitTimeoutMs: number
  private readonly logs: DevboxJobLogStore | undefined
  private readonly envFilePath: string | undefined
  private readonly envFilePathForRun?: () => string | undefined
  private readonly logOffsets = new Map<string, number>()
  private readonly specs = new Map<string, DevboxJobSpec>()
  private systemdHubCheck: Promise<void> | undefined

  constructor(options: JobTransportOptions) {
    if (!ID_PATTERN.test(options.profileId)) {
      throw new Error('Invalid Devbox profile identifier.')
    }
    this.runner = options.runner
    this.profileId = options.profileId
    this.root = options.remoteStateRoot
      ? shellEscape(options.remoteStateRoot)
      : `$HOME/.local/state/devbox/${shellEscape(options.profileId)}/jobs`
    this.waitPollMs = options.waitPollMs ?? 250
    this.waitTimeoutMs = options.waitTimeoutMs ?? 24 * 60 * 60 * 1000
    this.logs = options.logs
    this.envFilePath = options.envFilePath; this.envFilePathForRun = options.envFilePathForRun
    // The supervisor's 16-hex suffix is 64 bits. The job ID is also in the
    // unit name, while the registry compares the complete 256-bit spec hash.
    // Widening here would violate supervisor match checks, so the collision
    // domain is bounded to one ID and conflicting specs fail closed.
  }

  async find(id: string): Promise<DevboxRemoteJob | null> {
    await this.ensureSystemdHub()
    this.assertId(id)
    const output = await this.runner.command(findScript(this.root, id), 10_000)
    const line = output.trim().split('\n').at(-1) ?? ''
    return line ? parseRecord(line) : null
  }


  async createIfAbsent(request: DevboxRemoteJobCreateRequest) {
    await this.ensureSystemdHub()
    this.assertId(request.id)
    this.assertSpec(request.spec)
    if (request.specHash.length !== 64 || !/^[a-f0-9]+$/.test(request.specHash)) {
      throw this.conflict('job-spec-hash')
    }
    await this.stageCredentialEnv()
    this.specs.set(request.id, request.spec)
    const record = [
      request.id,
      request.specHash,
      request.unitName,
      request.cgroupPath,
      'registered'
    ].join('\t')
    const output = await this.runner.script(
      createScript(this.root, request.id, request.specHash, record),
      15_000
    )
    const line = output.trim().split('\n').at(-1) ?? ''
    if (line.startsWith('CONFLICT')) {
      throw this.conflict('job-spec-hash')
    }
    const job = parseRecord(line.replace(/^created\t|^existing\t/, ''))
    if (job.specHash !== request.specHash) {
      throw this.conflict('job-spec-hash')
    }
    if (job.unitName !== request.unitName || job.cgroupPath !== request.cgroupPath) {
      throw this.conflict('job-unit')
    }
    if (!line.startsWith('created\t') && !line.startsWith('existing\t')) {
      throw this.conflict('job-registry')
    }
    return { created: line.startsWith('created\t'), job }
  }

  async start(job: DevboxRemoteJob): Promise<DevboxRemoteJob> {
    await this.ensureSystemdHub()
    const spec = this.specs.get(job.id)
    if (!spec) { throw this.conflict('job-spec-unavailable') }
    this.assertSpec(spec)
    await this.stageCredentialEnv()
    const envFilePath = this.currentEnvFilePath()
    const output = await this.runner.script(
      startScript(this.root, job, spec, envFilePath === undefined ? undefined : devboxCredentialEnvRemotePath(this.profileId)),
      30_000
    )
    const line = output.trim().split('\n').at(-1) ?? ''
    return parseRecord(line.replace(/^started\t/, ''))
  }

  async cancel(job: DevboxRemoteJob): Promise<void> { await this.ensureSystemdHub(); await this.runner.command(cancelScript(this.root, job), 15_000) }

  private ensureSystemdHub(): Promise<void> {
    this.systemdHubCheck ??= this.runner.command('uname -s', 10_000).then((platform) => {
      if (platform.trim() === 'Darwin') { throw new Error(`detached jobs require a systemd hub; ${this.profileId} is a macOS hub — use db shell instead`) }
    })
    return this.systemdHubCheck
  }

  async wait(job: DevboxRemoteJob): Promise<DevboxRemoteJob> {
    const deadline = Date.now() + this.waitTimeoutMs
    let current = job
    while (!TERMINAL.has(current.status)) {
      if (Date.now() >= deadline) {
        throw createDevboxError('unknown', {
          retryable: true,
          context: { field: 'job-wait-timeout' }
        })
      }
      await delay(this.waitPollMs)
      current = (await this.find(job.id)) ?? current
    }
    await this.syncLog(job.id)
    return current
  }

  async syncLog(id: string): Promise<void> {
    if (!this.logs) {
      return
    }
    const offset = this.logOffsets.get(id) ?? this.logs.tail(id).nextOffset
    try {
      const output = await this.runner.command(logScript(this.root, id, offset), 10_000)
      if (output) {
        this.logs.append(id, output)
        this.logOffsets.set(id, offset + Buffer.byteLength(output, 'utf8'))
      }
    } catch {
      // Workload completion must not be hidden by a best-effort log fetch.
    }
  }

  private currentEnvFilePath(): string | undefined {
    return this.envFilePathForRun?.() ?? this.envFilePath
  }

  private async stageCredentialEnv(): Promise<void> {
    const localPath = this.currentEnvFilePath()
    if (localPath === undefined) { return }
    await stageDevboxCredentialEnv(this.runner, this.profileId, localPath)
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw this.conflict('job-id')
    }
  }

  private assertSpec(spec: DevboxJobSpec): void {
    for (const key of Object.keys(spec.environment ?? {})) {
      if (!ENV_PATTERN.test(key)) {
        throw this.conflict('job-environment')
      }
    }
  }

  private conflict(field: string) {
    return createDevboxError('operation_conflict', { context: { field } })
  }
}

function findScript(root: string, id: string): string {
  return [
    'set -Eeuo pipefail',
    `root=${root}`,
    `id=${shellEscape(id)}`,
    'record="$root/$id/record"',
    'if [ ! -f "$record" ]; then exit 0; fi',
    'line=$(cat "$record")',
    'unit=$(printf "%s" "$line" | cut -f3)',
    'active=$(systemctl --user show "$unit" --property=ActiveState --value 2>/dev/null || true)',
    'result=$(systemctl --user show "$unit" --property=Result --value 2>/dev/null || true)',
    'exit_code=$(systemctl --user show "$unit" --property=ExecMainStatus --value 2>/dev/null || true)',
    'status=$(printf "%s" "$line" | cut -f5)',
    'if [ "$active" = active ] || [ "$active" = activating ]; then status=running; fi',
    'if [ "$active" = inactive ] || [ "$active" = failed ]; then',
    '  if [ -n "$result" ]; then if [ "$result" = success ]; then status=completed; else status=failed; fi; fi',
    'fi',
    'if [ "$status" != registered ] && [ -n "$exit_code" ] && [ "$exit_code" != "-" ]; then',
    '  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$(printf "%s" "$line" | cut -f1)" "$(printf "%s" "$line" | cut -f2)" "$(printf "%s" "$line" | cut -f3)" "$(printf "%s" "$line" | cut -f4)" "$status" "$exit_code" > "$record.tmp.$$"',
    '  mv -f "$record.tmp.$$" "$record"',
    'fi',
    'printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$(printf "%s" "$line" | cut -f1)" "$(printf "%s" "$line" | cut -f2)" "$(printf "%s" "$line" | cut -f3)" "$(printf "%s" "$line" | cut -f4)" "$status" "$exit_code"'
  ].join('\n')
}

function createScript(root: string, id: string, expectedHash: string, record: string): string {
  return [
    'set -Eeuo pipefail',
    'umask 077',
    `root=${root}`,
    `id=${shellEscape(id)}`,
    `expected=${shellEscape(expectedHash)}`,
    `record=${shellEscape(record)}`,
    'job="$root/$id"',
    'mkdir -p "$root"',
    // mkdir is the remote create-if-absent primitive; only its winner writes
    // the record, so a lost acknowledgement cannot create a second job.
    'if mkdir "$job" 2>/dev/null; then',
    '  tmp="$job/.record.$$"',
    '  printf "%s\\n" "$record" > "$tmp"',
    '  mv -f "$tmp" "$job/record"',
    '  printf "created\\t%s\\n" "$(cat "$job/record")"',
    '  exit 0',
    'fi',
    'for attempt in $(seq 1 50); do',
    '  if [ -f "$job/record" ]; then',
    '    line=$(cat "$job/record")',
    '    actual=$(printf "%s" "$line" | cut -f2)',
    '    if [ "$actual" != "$expected" ]; then printf "CONFLICT\\n"; exit 42; fi',
    '    printf "existing\\t%s\\n" "$line"',
    '    exit 0',
    '  fi',
    '  sleep 0.02',
    'done',
    'exit 75'
  ].join('\n')
}

function startScript(root: string, job: DevboxRemoteJob, spec: DevboxJobSpec, envFilePath?: string): string {
  const command = spec.command.map(shellEscape).join(' ')
  const env = Object.entries(spec.environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `--setenv=${shellEscape(`${key}=${value}`)}`)
    .join(' ')
  const credentialEnv = envFilePath === undefined ? '' : `--property=EnvironmentFile=${shellEscape(envFilePath)}`
  return [
    'set -Eeuo pipefail',
    'umask 077',
    `root=${root}`,
    `id=${shellEscape(job.id)}`,
    `unit=${shellEscape(job.unitName)}`,
    `cwd=${shellEscape(spec.cwd)}`,
    'job="$root/$id"',
    'log="$job/workload.log"',
    'mkdir -p "$job"',
    `systemd-run --user --unit="$unit" --working-directory="$cwd" ${env} ${credentialEnv} --property=StandardOutput=append:"$log" --property=StandardError=append:"$log" -- ${command}`,
    'active=$(systemctl --user show "$unit" --property=ActiveState --value 2>/dev/null || true)',
    'result=$(systemctl --user show "$unit" --property=Result --value 2>/dev/null || true)',
    'exit_code=$(systemctl --user show "$unit" --property=ExecMainStatus --value 2>/dev/null || true)',
    'status=registered',
    'if [ "$active" = active ] || [ "$active" = activating ]; then status=running; fi',
    'if [ "$active" = inactive ] || [ "$active" = failed ]; then if [ "$result" = success ]; then status=completed; else status=failed; fi; fi',
    'tmp="$job/.record.$$"',
    `printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" ${shellEscape(job.id)} ${shellEscape(job.specHash)} ${shellEscape(job.unitName)} ${shellEscape(job.cgroupPath)} "$status" "$exit_code" > "$tmp"`,
    'mv -f "$tmp" "$job/record"',
    'printf "started\\t%s\\n" "$(cat "$job/record")"'
  ].join('\n')
}

function logScript(root: string, id: string, offset: number): string {
  return [
    'set -Eeuo pipefail',
    `root=${root}`,
    `id=${shellEscape(id)}`,
    `offset=${Math.max(0, Math.floor(offset)) + 1}`,
    'log="$root/$id/workload.log"',
    'if [ -f "$log" ]; then tail -c +"$offset" "$log" | head -c 1048576 || true; fi'
  ].join('\n')
}

function cancelScript(root: string, job: DevboxRemoteJob): string {
  return [
    'set -Eeuo pipefail',
    `root=${root}`,
    `id=${shellEscape(job.id)}`,
    `unit=${shellEscape(job.unitName)}`,
    'systemctl --user stop "$unit"',
    'job="$root/$id"',
    'tmp="$job/.record.$$"',
    `printf "%s\\t%s\\t%s\\t%s\\t%s\\n" ${shellEscape(job.id)} ${shellEscape(job.specHash)} ${shellEscape(job.unitName)} ${shellEscape(job.cgroupPath)} cancelled > "$tmp"`,
    'mv -f "$tmp" "$job/record"'
  ].join('\n')
}

function parseRecord(value: string): DevboxRemoteJob {
  const fields = value.split('\t')
  const [id, specHash, unitName, cgroupPath, status, exitCode] = fields
  if (
    !id ||
    !specHash ||
    !unitName ||
    !cgroupPath ||
    !['registered', 'running', 'completed', 'failed', 'cancelled'].includes(status)
  ) {
    throw createDevboxError('operation_conflict', { context: { field: 'job-record' } })
  }
  return {
    id,
    specHash,
    unitName,
    cgroupPath,
    status: status as DevboxRemoteJob['status'],
    ...(exitCode ? { exitCode: Number(exitCode) } : {})
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { createScript as createDevboxJobCreateScript, startScript as createDevboxJobStartScript }
