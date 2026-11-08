import { asRecord, keyValue, section, stringValue, table, type FormatRecord, type StageStatus } from './format-sections'
import type { Presentation } from './presentation'

export type DeviceStageRendering = {
  title: string
  status: StageStatus
  body: string[]
  trailing?: string
}

/** Human rendering for `devbox device` (list) and `devbox device --default …` (set/show/clear). */
export function renderDeviceStage(presentation: Presentation, command: string, record: FormatRecord): DeviceStageRendering {
  return command === 'device ls' ? renderList(presentation, record) : renderDefault(presentation, record)
}

function renderList(presentation: Presentation, record: FormatRecord): DeviceStageRendering {
  const devices = Array.isArray(record.devices) ? record.devices.map(asRecord) : []
  const body = [keyValue(presentation, 'Selection', {
    default: defaultLabel(record.defaultDevice, record.defaultProfile)
  })]
  if (devices.length === 0) {
    body.push(presentation.emptyState('No devices configured.'))
  } else {
    body.push(section(presentation, 'Devices', table(presentation, {
      rows: devices,
      columns: [
        { header: 'DEVICE', get: (device) => `${device.default === true ? '* ' : '  '}${stringValue(device.device, '-')}`, priority: 10 },
        { key: 'profileId', header: 'PROFILE', priority: 9 },
        { header: 'USER@HOST', get: (device) => endpoint(device), priority: 8 }
      ],
      gap: 2,
      headerStyle: 'section'
    })))
  }
  return {
    title: 'Devbox devices',
    status: devices.length > 0
      ? { kind: 'success', message: `${devices.length} device${devices.length === 1 ? '' : 's'} available` }
      : { kind: 'muted', message: 'No devices configured' },
    body,
    ...(devices.length > 0 ? { trailing: 'Set the default: devbox device --default <alias>' } : {})
  }
}

function renderDefault(presentation: Presentation, record: FormatRecord): DeviceStageRendering {
  const hasDefault = typeof record.defaultProfile === 'string'
  const body = [keyValue(presentation, 'Default device', {
    device: stringValue(record.device, hasDefault ? 'none (no alias)' : 'none'),
    profile: stringValue(record.defaultProfile, 'none'),
    host: hasDefault ? endpoint(record) : 'none'
  })]
  const override = typeof record.environmentOverride === 'string' ? record.environmentOverride : undefined
  const messages: Record<string, string> = {
    set: 'Default device updated',
    clear: 'Default device cleared',
    show: hasDefault ? 'Default device' : 'No default device set'
  }
  return {
    title: 'Devbox default device',
    status: { kind: hasDefault || record.action === 'clear' ? 'success' : 'muted', message: messages[stringValue(record.action, 'show')] ?? 'Default device' },
    body,
    ...(override === undefined ? {} : { trailing: `DEVBOX_PROFILE=${override} is set in this environment and overrides the default.` })
  }
}

function defaultLabel(device: unknown, profile: unknown): string {
  if (typeof profile !== 'string') {return 'none'}
  return typeof device === 'string' ? `${device} (profile ${profile})` : profile
}

function endpoint(record: FormatRecord): string {
  const port = typeof record.port === 'number' && record.port !== 22 ? `:${record.port}` : ''
  return `${stringValue(record.username)}@${stringValue(record.host)}${port}`
}
