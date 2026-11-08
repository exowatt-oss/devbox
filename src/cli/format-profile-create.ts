import {
  asRecord,
  keyValue,
  stringValue,
  type FormatRecord,
  type StageStatus
} from './format-sections'
import type { Presentation } from './presentation'

export type ProfileCreateStageRendering = {
  body: string[]
  status: StageStatus
}

export function renderProfileCreateStage(
  presentation: Presentation,
  record: FormatRecord
): ProfileCreateStageRendering {
  const profile = asRecord(record.profile)
  const identity = asRecord(asRecord(profile.sshTarget).identity)
  const roots = asRecord(profile.roots)
  const body = [
    keyValue(presentation, 'Profile', {
      profile: stringValue(profile.id),
      displayName: stringValue(profile.displayName, stringValue(profile.id)),
      host: stringValue(identity.host),
      username: stringValue(identity.username),
      localRoot: stringValue(roots.localRoot),
      remoteRoot: stringValue(roots.remoteRoot)
    }),
    keyValue(presentation, 'Enrollment', {
      knownHostsFile: stringValue(record.knownHostsFile),
      fingerprints: Array.isArray(record.fingerprints) ? record.fingerprints.length : 0,
      dryRun: record.dryRun === true ? 'yes' : 'no'
    })
  ]
  const status: StageStatus = {
    kind: 'success',
    message: record.dryRun === true ? 'Profile enrollment preview ready' : 'Profile enrolled'
  }
  return { body, status }
}
