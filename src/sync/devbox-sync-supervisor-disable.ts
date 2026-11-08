import { createDevboxError } from '../shared/devbox-errors'
import {
  isDevboxSyncSessionOwnedByProfile,
  type DevboxSyncSessionIdentity
} from './devbox-sync-backend'
import type { SupervisorRuntime } from './devbox-sync-supervisor-runtime'

export async function terminateOwnedSessionsForDisable(runtime: SupervisorRuntime): Promise<void> {
  for (const backend of runtime.backends.values()) {
    if (backend.shutdownForDisable) {
      await backend.shutdownForDisable()
      continue
    }
    await backend.flush()
    await backend.pause()
    const sessions = ownedSessions(runtime, await backend.listSessions())
    for (const session of sessions) {
      await backend.terminate(session.sessionId)
    }
    const remaining = ownedSessions(runtime, await backend.listSessions())
    if (remaining.length > 0) {
      throw createDevboxError('operation_conflict', {
        context: {
          profileId: runtime.profileId,
          field: 'active-session-on-disable'
        }
      })
    }
  }
}

function ownedSessions(
  runtime: SupervisorRuntime,
  sessions: readonly DevboxSyncSessionIdentity[]
): readonly DevboxSyncSessionIdentity[] {
  return sessions.filter((session) =>
    isDevboxSyncSessionOwnedByProfile(session, runtime.profileId, session.backend)
  )
}
