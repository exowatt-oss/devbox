import {
  asRecord,
  keyValue,
  section,
  stringValue,
  type FormatRecord,
  type StageStatus
} from './format-sections'
import type { Presentation } from './presentation'

export type PasteStageRendering = {
  body: string[]
  status: StageStatus
  trailing?: string
}

/** Human rendering for `devbox profile paste enable|disable|show`. */
export function renderPasteStage(
  presentation: Presentation,
  command: string,
  record: FormatRecord
): PasteStageRendering {
  const roots = Array.isArray(record.roots) ? record.roots.map(asRecord) : []
  const enabled = record.enabled === true
  const profileId = stringValue(record.profileId)
  const body: string[] = [
    keyValue(presentation, 'Paste mirroring', {
      profile: profileId,
      enabled: enabled ? 'yes' : 'no',
      roots: String(roots.length)
    })
  ]
  if (enabled && roots.length > 0) {
    body.push(section(presentation, 'Roots', roots.map(describeRoot).join('\n')))
  } else {
    body.push(presentation.emptyState(enabled ? 'No paste roots configured.' : 'Paste mirroring is disabled.'))
  }

  const remote = asRecord(record.remoteRoot)
  const remoteStatus = stringValue(remote.status, '')
  const remoteReady = remoteStatus === '' || remoteStatus === 'ready' || remoteStatus === 'skipped'
  if (remoteStatus !== '') {
    body.push(keyValue(presentation, 'Remote root', {
      path: stringValue(remote.root),
      status: remoteStatus
    }))
    if (typeof remote.hint === 'string' && remote.hint) {
      body.push(section(presentation, 'Fix', remote.hint))
    }
  }

  const status: StageStatus = !enabled
    ? { kind: 'muted', message: 'Paste mirroring disabled' }
    : remoteReady
      ? { kind: 'success', message: 'Paste mirroring enabled' }
      : { kind: 'warning', message: 'Paste mirroring enabled; remote root needs preparation' }

  let trailing: string | undefined
  if (command === 'profile paste enable' && enabled) {
    trailing = record.updatedExistingRoot === true
      ? `Run: devbox disable --profile ${profileId} && devbox pair --profile ${profileId}`
      : `Run: devbox pair --profile ${profileId}`
  }
  return { body, status, ...(trailing === undefined ? {} : { trailing }) }
}

function describeRoot(root: FormatRecord): string {
  const patterns = Array.isArray(root.patterns) ? root.patterns.join(', ') : 'none'
  return `${stringValue(root.id)}: ${stringValue(root.localRoot)} -> ${stringValue(root.remoteRoot)} · patterns ${patterns}`
}
