import {
  asRecord,
  stringValue,
  type FormatRecord,
  type StageStatus
} from './format-sections'
import type { Presentation } from './presentation'

export type ShellDevicesStageRendering = {
  body: string[]
  status: StageStatus
  title?: string
}

/** Human rendering for `shell rm --unattached --all-devices`; `shell ls` lives in format-shell-ls.ts. */
export function renderShellDevicesStage(presentation: Presentation, record: FormatRecord): ShellDevicesStageRendering {
  return renderCleanup(presentation, record)
}

function renderCleanup(presentation: Presentation, record: FormatRecord): ShellDevicesStageRendering {
  const devices = Array.isArray(record.devices) ? record.devices.map(asRecord) : []
  const body = devices.map((device) => {
    const profiles = Array.isArray(device.profiles) ? device.profiles.map(asRecord) : []
    const reachable = profiles.filter((profile) => profile.reachable === true)
    const count = reachable.reduce((sum, profile) => sum + (typeof profile.count === 'number' ? profile.count : 0), 0)
    const sessions = reachable.flatMap((profile) => Array.isArray(profile.sessions) ? profile.sessions.map(String) : [])
    const lines = [presentation.wrap(`${stringValue(device.device)}: ${count} closed${sessions.length > 0 ? ` (${sessions.join(', ')})` : ''}`).join('\n')]
    for (const profile of profiles.filter((item) => item.reachable !== true)) {
      lines.push(...presentation.wrap(`profile ${stringValue(profile.profileId)}: unreachable — ${stringValue(profile.error, 'unreachable')}`).map((line) => presentation.style(line, 'muted')))
    }
    return lines.join('\n')
  })
  const count = typeof record.count === 'number' ? record.count : 0
  const summary = `${count} detached shell session${count === 1 ? '' : 's'} closed on ${devices.length} device${devices.length === 1 ? '' : 's'}`
  return {
    title: 'Devbox shell rm --unattached --all-devices',
    body,
    status: { kind: 'success', message: presentation.wrap(summary).join('\n') }
  }
}
