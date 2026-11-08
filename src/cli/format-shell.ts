import { section, stringValue, table, type FormatRecord, type StageStatus } from './format-sections'
import type { Presentation } from './presentation'

export type DevboxShellReconnectRender = {
  title: string
  status: StageStatus
  body: readonly string[]
  trailing?: string
}

export function renderDevboxShellReconnectAll(
  presentation: Presentation,
  record: FormatRecord
): DevboxShellReconnectRender {
  const rows = Array.isArray(record.rows) ? record.rows.map(asRecord) : []
  const dryRun = record.dryRun === true
  const failed = rows.filter((row) => row.status === 'failed').length
  const status: StageStatus = dryRun
    ? { kind: 'info', message: 'Dry run · nothing launched' }
    : failed > 0
      ? { kind: 'warning', message: `${failed} reconnect launch${failed === 1 ? '' : 'es'} failed` }
      : { kind: 'success', message: 'Reconnect plan completed' }
  return {
    title: `Devbox shell reconnect --all (${typeof record.profileId === 'string' ? record.profileId : 'all devices'})`,
    status,
    body: [section(presentation, 'Sessions', table(presentation, {
      rows,
      columns: [
        { key: 'device', header: 'DEVICE', priority: 9, optional: true },
        { key: 'id', header: 'ID', priority: 10 },
        { key: 'title', header: 'TAB TITLE', priority: 9, optional: true },
        { key: 'action', header: 'ACTION', priority: 8 },
        { key: 'status', header: 'STATUS', priority: 8 },
        { header: 'TARGET', get: (row) => stringValue(row.handle, stringValue(row.error, '-')), priority: 7, optional: true },
        { key: 'command', header: 'COMMAND', priority: 6, optional: true }
      ],
      gap: 2,
      headerStyle: 'section'
    })), ...skippedDevicesSection(presentation, record)],
    trailing: dryRun
      ? 'Dry run — nothing launched. Re-run without --dry-run to open the tabs.'
      : reconnectAllFooter(rows)
  }
}

function skippedDevicesSection(presentation: Presentation, record: FormatRecord): string[] {
  const skipped = Array.isArray(record.skippedDevices) ? record.skippedDevices.map(asRecord) : []
  if (skipped.length === 0) {return []}
  const lines = skipped.map((device) => `${stringValue(device.device)}: ${stringValue(device.error, stringValue(device.status))}`)
  return [section(presentation, 'Skipped devices', lines.join('\n'))]
}

function reconnectAllFooter(rows: readonly FormatRecord[]): string {
  const launched = rows.filter((row) => row.status === 'launched').length
  const resumed = rows.filter((row) => row.action === 'here' && row.status !== 'failed').length
  const attached = rows.filter((row) => row.action === 'skip-attached').length
  const open = rows.filter((row) => row.status === 'already-open').length
  const openText = open === 0 ? '' : ` · ${open} already open in Forca`
  return `${launched} launched in Forca · ${resumed} resumed here · ${attached} already attached${openText}`
}

function asRecord(value: unknown): FormatRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as FormatRecord
    : {}
}
