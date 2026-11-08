import { errorDetails, devboxExitCode, formatDevboxError } from './format-errors'
import { formatDevboxStage } from './format-human'
import type { PresentationOptions } from './presentation'

export const DEVBOX_CLI_SCHEMA_VERSION = 1 as const

export type DevboxJsonEnvelope = {
  schemaVersion: typeof DEVBOX_CLI_SCHEMA_VERSION
  command: string
  ok: boolean
  operationKey?: string
  result?: unknown
  error?: {
    code: string
    message: string
    retryable: boolean
    context?: unknown
    blocked?: unknown
  }
}

const SECRET_KEY = /auth|credential|password|private|secret|token|capability|cookie/i
const PUBLIC_STATUS_KEYS = new Set([
  'authorityScope',
  'defaultAuthority',
  'topology',
  'owner',
  'epochSequence',
  'transition',
  'witnesses',
  'manifest',
  'localGit',
  'remoteGit',
  'repositories',
  'dirtyRepositories',
  'unpublishedRepositories',
  'passiveRefresh',
  'syncBarrier',
  'fence',
  'enabled',
  'parkedGitName',
  'refreshStrategy',
  'requireCleanHandoff',
  'requirePublishedHead',
  'excludeWorktrees',
  'capability'
])

export function printDevboxResult(
  command: string,
  _operation: string,
  value: unknown,
  operationId: string,
  json: boolean,
  formatter: (
    value: unknown,
    operationId: string,
    command: string,
    options?: PresentationOptions
  ) => string,
  presentationOptions: PresentationOptions = {}
): void {
  if (json) {
    console.log(JSON.stringify(sortObject({
      schemaVersion: DEVBOX_CLI_SCHEMA_VERSION,
      command,
      ok: true,
      operationKey: operationId,
      result: sanitizeResult(command, value) ?? null
    }), null, 2))
    return
  }
  console.log(formatter(value, operationId, command, presentationOptions))
}

export function printDevboxError(
  command: string,
  error: unknown,
  json: boolean,
  presentationOptions: PresentationOptions = {}
): void {
  const details = errorDetails(error)
  const envelope: DevboxJsonEnvelope = {
    schemaVersion: DEVBOX_CLI_SCHEMA_VERSION,
    command,
    ok: false,
    error: {
      code: details.code,
      message: details.message,
      retryable: details.retryable,
      ...(details.context === undefined ? {} : { context: sanitize(details.context) }),
      ...(details.blocked === undefined ? {} : { blocked: details.blocked })
    }
  }
  if (json) {
    console.log(JSON.stringify(sortObject(envelope), null, 2))
  } else {
    console.error(formatDevboxError(error, presentationOptions))
  }
}

function sanitizeResult(command: string, value: unknown): unknown {
  if (command === 'jobs log' && isRecord(value)) {
    const { text: _text, ...rest } = value
    return { ...rest, textAvailable: typeof _text === 'string' }
  }
  return sanitize(value)
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key) && !PUBLIC_STATUS_KEYS.has(key)) {
    return '[REDACTED]'
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((name) => [name, sanitize(value[name], name)])
    )
  }
  return value
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObject(value[key])])
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { devboxExitCode, formatDevboxError, formatDevboxStage }
