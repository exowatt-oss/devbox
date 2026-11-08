export type DevboxBlockedOperation = {
  command: 'doctor' | 'repair' | 'conflicts' | 'support'
  channel: string
  args: Record<string, string | boolean>
  response: string
}

export const DEVBOX_BLOCKED_OPERATIONS: readonly DevboxBlockedOperation[] = [
  { command: 'doctor', channel: 'devbox:doctor', args: { profileId: 'string' }, response: 'DevboxIpcResult<{ checks: readonly { name: string; state: string; detail?: string }[]; repairable: boolean }>' },
  { command: 'repair', channel: 'devbox:repair', args: { profileId: 'string', force: 'boolean', confirmation: 'string' }, response: 'DevboxIpcResult<DevboxIpcStatus>' },
  { command: 'conflicts', channel: 'devbox:listConflicts', args: { profileId: 'string' }, response: 'DevboxIpcResult<{ conflicts: readonly { path: string; side: "local" | "remote"; status: string }[] }>' },
  { command: 'support', channel: 'devbox:supportBundle', args: { profileId: 'string', includeLogs: 'boolean' }, response: 'DevboxIpcResult<{ bundleId: string; files: readonly string[] }>' }
]

export class DevboxBlockedError extends Error {
  readonly code = 'devbox_operation_blocked' as const
  readonly retryable = false
  readonly blockedOperation: DevboxBlockedOperation

  constructor(operation: DevboxBlockedOperation) {
    super(`The '${operation.command}' command is BLOCKED: T-006 does not expose ${operation.channel}.`)
    this.name = 'DevboxBlockedError'
    this.blockedOperation = operation
  }
}
