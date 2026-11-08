import type { DevboxError } from '../shared/devbox-errors'
import { redactStringValue } from '../core/devbox-redactor-strings'
import { CliArgumentError } from './args'
import { DEVBOX_BLOCKED_OPERATIONS, DevboxBlockedError } from './operations'
import {
  formatShape,
  isRecord,
  section,
  table,
  type FormatRecord,
  type HumanTableOptions
} from './format-sections'
import { createPresentation, type PresentationOptions } from './presentation'

const ERROR_ENV_VALUE = /\b([A-Z_][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/gu

export type ErrorDetails = {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly context?: unknown
  readonly blocked?: unknown
}

export function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof DevboxBlockedError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      retryable: false,
      blocked: DEVBOX_BLOCKED_OPERATIONS
    }
  }
  if (error instanceof CliArgumentError) {
    return { code: error.code, message: safeErrorMessage(error.message), retryable: false }
  }
  if (isDevboxError(error)) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      retryable: error.retryable,
      context: error.context
    }
  }
  if (error instanceof Error) {
    return { code: errorCode(error), message: safeErrorMessage(error.message), retryable: false }
  }
  return { code: 'unknown', message: safeErrorMessage(String(error)), retryable: false }
}

export function formatDevboxError(error: unknown, options: PresentationOptions = {}): string {
  const presentation = createPresentation(options)
  const details = errorDetails(error)
  const lines = [
    presentation.title('Devbox error'),
    presentation.status('error', details.message),
    '',
    section(
      presentation,
      'Details',
      presentation.keyValue({
        code: details.code,
        retryable: details.retryable ? 'yes' : 'no'
      })
    )
  ]

  if (details.context !== undefined && isRecord(details.context)) {
    lines.push(
      '',
      section(presentation, 'Context', presentation.keyValue(details.context))
    )
  }
  if (details.blocked) {
    const rows: FormatRecord[] = DEVBOX_BLOCKED_OPERATIONS.map((operation) => ({
      command: operation.command,
      channel: operation.channel,
      args: formatShape(operation.args),
      response: operation.response
    }))
    const columns: HumanTableOptions['columns'] = [
      { key: 'command', header: 'COMMAND', priority: 8, minWidth: 7 },
      { key: 'channel', header: 'CHANNEL', priority: 7, minWidth: 12 },
      { key: 'args', header: 'ARGS', optional: true, priority: 2, minWidth: 4 },
      { key: 'response', header: 'RESPONSE', priority: 5, minWidth: 12 }
    ]
    lines.push(
      '',
      section(
        presentation,
        'Blocked runtime operations required',
        table(presentation, { rows, columns, gap: 2, headerStyle: 'section' })
      )
    )
  }
  return lines.join('\n')
}

export function devboxExitCode(error: unknown): number {
  switch (errorCode(error)) {
    case 'invalid_argument': return 2
    case 'devbox_operation_blocked': return 3
    case 'auth_required':
    case 'bridge_denied':
    case 'bridge_scope_denied': return 5
    case 'operation_conflict': return 6
    case 'cancelled': return 130
    default: return 1
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown'
}

function isDevboxError(error: unknown): error is DevboxError {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'message' in error
    && 'retryable' in error
}

function safeErrorMessage(message: string): string {
  const redacted = redactStringValue(message, 16_384)
  const text = typeof redacted === 'string' ? redacted : '[REDACTED]'
  return text.replace(ERROR_ENV_VALUE, '$1=[redacted:env-value]')
}
