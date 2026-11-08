import type { DevboxError } from './devbox-errors'
import { validateDevboxJobEnvironment } from './devbox-job-environment'

export const DEVBOX_IPC_SCHEMA_VERSION = 1 as const
export const DEVBOX_IPC_STATUS_EVENT = 'devbox:status' as const
export const DEVBOX_IPC_CHANNELS = [
  'devbox:getStatus',
  'devbox:start',
  'devbox:disable',
  'devbox:handoff',
  'devbox:launchTerminal',
  'devbox:launchAgent',
  'devbox:launchPhi',
  'devbox:runConsistent',
  'devbox:openPort',
  'devbox:jobStatus',
  'devbox:cancelJob',
  'devbox:tailJobLog'
] as const

export type DevboxIpcChannel = (typeof DEVBOX_IPC_CHANNELS)[number]
export type DevboxIpcStatus = {
  schemaVersion: typeof DEVBOX_IPC_SCHEMA_VERSION
  profileId: string
  state: string
  operationId: string | null
  sync: unknown
  journalRestored: boolean
  generationId: string | null
  observedAt: number
}

export type DevboxIpcResult<T> =
  | { schemaVersion: typeof DEVBOX_IPC_SCHEMA_VERSION; ok: true; value: T }
  | { schemaVersion: typeof DEVBOX_IPC_SCHEMA_VERSION; ok: false; error: DevboxError }

export type DevboxProfileArgs = { profileId: string }
export type DevboxHandoffArgs = DevboxProfileArgs & {
  targetOwner: 'local' | 'remote'
}
export type DevboxTerminalArgs = DevboxProfileArgs & {
  localPath: string
  command?: readonly string[]
}
export type DevboxPhiArgs = DevboxProfileArgs & {
  localPath: string
  sessionId: string
  relayEpoch: string
}
export type DevboxRunArgs = DevboxProfileArgs & {
  job: {
    id: string
    command: readonly string[]
    cwd: string
    environment?: Readonly<Record<string, string>>
    detached: true
  }
}
export type DevboxOpenPortArgs = DevboxProfileArgs & {
  remotePort: number
  allowPublicListener?: boolean
  label?: string
}
export type DevboxJobArgs = DevboxProfileArgs & { jobId: string }
export type DevboxTailJobLogArgs = DevboxJobArgs & { offset?: number; limit?: number }

type DevboxRecord = Record<string, unknown>

export type DevboxRunArgsValidation =
  | { ok: true; value: DevboxRunArgs }
  | { ok: false; field: string }

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function isRecord(value: unknown): value is DevboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasOnlyFields(value: DevboxRecord, fields: readonly string[]): boolean {
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.getOwnPropertyNames(value).every((field) => fields.includes(field))
  )
}

function invalidRunArgs(field: string): DevboxRunArgsValidation {
  return { ok: false, field }
}

export function validateDevboxRunArgs(input: unknown): DevboxRunArgsValidation {
  if (!isRecord(input) || !hasOnlyFields(input, ['profileId', 'job'])) {
    return invalidRunArgs('run-args-fields')
  }
  const profileId = input.profileId
  if (typeof profileId !== 'string' || !ID_PATTERN.test(profileId)) {
    return invalidRunArgs('profile-id')
  }
  const rawJob = input.job
  if (
    !isRecord(rawJob) ||
    !hasOnlyFields(rawJob, ['id', 'command', 'cwd', 'environment', 'detached'])
  ) {
    return invalidRunArgs('job-fields')
  }
  if (typeof rawJob.id !== 'string' || !ID_PATTERN.test(rawJob.id)) {
    return invalidRunArgs('job-id')
  }
  if (!Array.isArray(rawJob.command)) {
    return invalidRunArgs('job-command')
  }
  const command = [...rawJob.command]
  if (
    command.length === 0 ||
    command.some(
      (value) => typeof value !== 'string' || value.length === 0 || value.includes('\u0000')
    )
  ) {
    return invalidRunArgs('job-command')
  }
  if (typeof rawJob.cwd !== 'string' || !rawJob.cwd || rawJob.cwd.includes('\u0000')) {
    return invalidRunArgs('job-cwd')
  }
  if (rawJob.detached !== true) {
    return invalidRunArgs('detached-required')
  }
  const environmentValidation = validateDevboxJobEnvironment(rawJob.environment)
  if (!environmentValidation.ok) {
    return invalidRunArgs('job-environment')
  }
  const job: DevboxRunArgs['job'] = {
    id: rawJob.id,
    command: command as string[],
    cwd: rawJob.cwd,
    detached: true
  }
  if (rawJob.environment !== undefined) {
    const environment = rawJob.environment as Record<string, string>
    job.environment = Object.fromEntries(Object.entries(environment))
  }
  return { ok: true, value: { profileId, job } }
}

export function devboxIpcOk<T>(value: T): DevboxIpcResult<T> {
  return { schemaVersion: DEVBOX_IPC_SCHEMA_VERSION, ok: true, value }
}

export function devboxIpcError(error: DevboxError): DevboxIpcResult<never> {
  return { schemaVersion: DEVBOX_IPC_SCHEMA_VERSION, ok: false, error }
}
