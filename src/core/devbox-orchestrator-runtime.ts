import { join } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxOperationJournal } from './devbox-operation-journal'
import type { DevboxProfileStore } from './devbox-profile-store'
import { devboxSyncRequests } from './devbox-orchestrator-actions'
import type { DevboxOrchestratorOptions } from './devbox-orchestrator-types'
import { DevboxSyncSupervisor, type DevboxSyncSupervisorStatus } from '../sync/devbox-sync-supervisor'

export function createOrchestratorRuntime(input: {
  profileId: string
  profileStore: DevboxProfileStore
  journalRoot: string
  env: NodeJS.ProcessEnv | undefined
  options: DevboxOrchestratorOptions
  onStatus: (status: DevboxSyncSupervisorStatus) => void
}): {
  profile: DevboxProfileV1
  journal: DevboxOperationJournal
  supervisor: DevboxSyncSupervisor
  usingDefaultSupervisor: boolean
  journalRestored: boolean
} {
  const loaded = input.profileStore.loadProfile(input.profileId)
  if (loaded.status !== 'loaded') {
    if ('error' in loaded) {throw loaded.error}
    throw createDevboxError('profile_not_found')
  }
  const profile = loaded.profile
  const journal = new DevboxOperationJournal({
    journalPath: join(input.journalRoot, profile.id, 'operations.jsonl')
  })
  const replay = journal.replay()
  if (replay.status !== 'ok') {throw replay.error ?? createDevboxError('journal_corrupt')}
  const requests = devboxSyncRequests(profile)
  const usingDefaultSupervisor = !input.options.supervisorFactory
  const supervisor = input.options.supervisorFactory
    ? input.options.supervisorFactory({ profile, journal, onStatus: input.onStatus })
    : DevboxSyncSupervisor.forProfile({
        profileId: profile.id,
        requests,
        journal,
        onStatus: input.onStatus
      })
  return {
    profile,
    journal,
    supervisor,
    usingDefaultSupervisor,
    journalRestored: replay.operations.length > 0
  }
}
