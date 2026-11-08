import type { DevboxSyncSupervisorStatus } from './devbox-sync-supervisor-contract'
import type { SupervisorRuntime } from './devbox-sync-supervisor-runtime'

export function emitStatus(runtime: SupervisorRuntime, status: DevboxSyncSupervisorStatus): void {
  if (!runtime.options.onStatus) {
    return
  }
  const signature = JSON.stringify(status)
  const now = runtime.now()
  const throttle = runtime.options.statusEventThrottleMs ?? 250
  if (signature === runtime.lastSignature || now - runtime.lastEmittedAt < throttle) {
    return
  }
  runtime.lastSignature = signature
  runtime.lastEmittedAt = now
  void runtime.options.onStatus(status)
}
