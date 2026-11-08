import { commandExecFileAsync } from '../shared/exec'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import type {
  DevboxSyncBackend,
  DevboxSyncConflict,
  DevboxSyncCreateRequest,
  DevboxSyncSessionIdentity
} from '../sync/devbox-sync-backend'
import type { MutagenCli } from '../sync/mutagen-cli'
import { MutagenSyncBackend } from '../sync/mutagen-sync-backend'
import { RsyncSyncBackend } from '../sync/rsync-sync-backend'

export type SyncFactories = {
  mutagenBackendFactory: (request: DevboxSyncCreateRequest) => Promise<DevboxSyncBackend>
  rsyncBackendFactory: (request: DevboxSyncCreateRequest) => DevboxSyncBackend
}

type SyncStores = {
  sessions: Map<string, DevboxSyncSessionIdentity>
  conflicts: Map<string, DevboxSyncConflict>
}

export function makeSyncFactories(
  identity: DevboxProfileV1['sshTarget']['identity'],
  mutagen: MutagenCli,
  stores: SyncStores = { sessions: new Map(), conflicts: new Map() },
  environment: NodeJS.ProcessEnv = process.env
): SyncFactories {
  const common = {
    sessionStore: sessionStore(stores),
    conflictStore: conflictStore(stores),
    backupStore: backupStore()
  }
  return {
    mutagenBackendFactory: async (request) => new MutagenSyncBackend({
      ...common,
      profileId: request.profileId,
      cli: mutagen,
      remoteEndpoint: () => `${identity.username}@${identity.host}:${request.remoteRoot}`
    }),
    rsyncBackendFactory: (request) => new RsyncSyncBackend({
      ...common,
      profileId: request.profileId,
      commandRunner: async (_command, args, options) => {
        try {
          const result = await commandExecFileAsync('rsync', args, { env: environment, signal: options?.signal })
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
        } catch (error) {
          const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
          return {
            exitCode: failure.code === 'ENOENT' ? 127 : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? String(error)
          }
        }
      }
    })
  }
}

function sessionStore(stores: SyncStores) {
  return {
    list: () => [...stores.sessions.values()],
    upsert: (session: DevboxSyncSessionIdentity) => stores.sessions.set(session.sessionId, session),
    remove: (session: DevboxSyncSessionIdentity) => stores.sessions.delete(session.sessionId)
  }
}

function conflictStore(stores: SyncStores) {
  return {
    list: () => [...stores.conflicts.values()],
    remove: (id: string) => stores.conflicts.delete(id)
  }
}

function backupStore() {
  return {
    create: async (conflict: DevboxSyncConflict) => ({
      id: `backup-${conflict.conflictId}`,
      conflictId: conflict.conflictId,
      localHash: conflict.local.hash,
      remoteHash: conflict.remote.hash,
      createdAt: Date.now()
    }),
    has: async (handle: { id: string }) => handle.id.startsWith('backup-')
  }
}
