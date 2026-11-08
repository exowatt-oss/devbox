import { asRecord, stringValue, type FormatRecord } from './format-sections'
import { visibleWidth, type Presentation } from './presentation'

/**
 * Compact `shell ls` (all devices) layout shared by the static (non-TTY) and
 * live (TTY) renderers: one aligned line per device, an indented session table
 * under reachable devices that have sessions, a summary and a one-line hint.
 */
export type ShellLsLayout = {
  nameWidth: number
  endpointWidth: number
  glyphs: boolean
  nowMs: number
}

export type ShellLsDeviceIdentity = {
  device: string
  username: string
  host: string
  port: number
  default: boolean
}

export const SHELL_LS_FOOTER = 'attach: db shell <name> · clean up: db shell rm --unattached --all-devices'

export function shellLsLayout(devices: readonly ShellLsDeviceIdentity[], glyphs: boolean, nowMs = Date.now()): ShellLsLayout {
  return {
    nameWidth: Math.max(0, ...devices.map((device) => deviceName(device).length)),
    endpointWidth: Math.max(0, ...devices.map((device) => deviceEndpoint(device).length)),
    glyphs,
    nowMs
  }
}

export function deviceName(device: Pick<ShellLsDeviceIdentity, 'device' | 'default'>): string {
  return `${device.device}${device.default ? ' (default)' : ''}`
}

export function deviceEndpoint(device: Pick<ShellLsDeviceIdentity, 'username' | 'host' | 'port'>): string {
  return `${device.username}@${device.host}${device.port === 22 ? '' : `:${device.port}`}`
}

/** `name  user@host  ` with both columns padded to the layout widths. */
export function deviceLinePrefix(presentation: Presentation, device: ShellLsDeviceIdentity, layout: ShellLsLayout): string {
  const name = deviceName(device).padEnd(layout.nameWidth)
  const endpoint = deviceEndpoint(device).padEnd(layout.endpointWidth)
  return `${device.default ? presentation.style(name, 'accent') : name}  ${presentation.style(endpoint, 'muted')}  `
}

export function renderShellLsDevice(presentation: Presentation, record: FormatRecord, layout: ShellLsLayout): string {
  const identity = toIdentity(record)
  const prefix = deviceLinePrefix(presentation, identity, layout)
  const status = stringValue(record.status, 'ok')
  if (status !== 'ok') {
    const glyph = layout.glyphs ? (status === 'skipped' ? '- ' : '✗ ') : ''
    const text = status === 'skipped'
      ? stringValue(record.error, 'skipped')
      : `unreachable (${stringValue(record.error, 'unreachable')})`
    const mutedPrefix = presentation.style(`${deviceName(identity).padEnd(layout.nameWidth)}  ${deviceEndpoint(identity).padEnd(layout.endpointWidth)}  `, 'muted')
    return fitDeviceLine(presentation, mutedPrefix, `${glyph}${text}`, (part) => presentation.style(part, 'muted'))
  }
  const profiles = Array.isArray(record.profiles) ? record.profiles.map(asRecord) : []
  const sessions: FormatRecord[] = profiles.flatMap((profile) => (Array.isArray(profile.sessions) ? profile.sessions : [])
    .map((session): FormatRecord => ({ ...asRecord(session), profileId: profile.profileId })))
  const recent = sessions.reduce<FormatRecord | undefined>((best, session) => best === undefined || usedAt(session) > usedAt(best) ? session : best, undefined)
  const seconds = `${(numberValue(record.elapsedMs) / 1000).toFixed(1)} s`
  const count = sessions.length === 0 ? 'no sessions' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
  const glyph = layout.glyphs ? '✓ ' : ''
  const line = fitDeviceLine(presentation, prefix, `${glyph}${count} · ${seconds}`, (part) => part.startsWith('✓ ')
    ? `${presentation.style('✓ ', 'success')}${presentation.style(part.slice(2), sessions.length === 0 ? 'muted' : 'value')}`
    : presentation.style(part, sessions.length === 0 ? 'muted' : 'value'))
  if (sessions.length === 0) {return line}
  const table = presentation.table<FormatRecord>({
    rows: sessions,
    columns: [
      { header: 'NAME', get: (session) => `${session === recent ? '* ' : '  '}${stringValue(session.name, '-')}`, priority: 10 },
      { header: 'ID', get: (session) => stringValue(session.id), priority: 10 },
      ...(profiles.length > 1 ? [{ header: 'PROFILE', get: (session: FormatRecord) => stringValue(session.profileId), priority: 6 }] : []),
      {
        header: 'STATE',
        get: (session) => session.attached === true ? 'attached' : 'detached',
        format: (value) => presentation.style(String(value), value === 'attached' ? 'success' : 'muted'),
        priority: 9
      },
      { header: 'AGE', get: (session) => formatAge(layout.nowMs, session.created), priority: 8 },
      { header: 'CWD', get: (session) => stringValue(session.cwd, '-'), optional: true, priority: 1, minWidth: 8 }
    ],
    gap: 2,
    separator: false,
    headerStyle: 'muted',
    width: Math.max(20, presentation.width - 4)
  })
  return [line, ...table.split('\n').map((row) => `    ${row}`)].join('\n')
}

/** Keep device lines inside the terminal: a status that does not fit moves under the device, indented. */
function fitDeviceLine(presentation: Presentation, prefix: string, status: string, style: (part: string) => string): string {
  if (visibleWidth(prefix) + visibleWidth(status) <= presentation.width) {return `${prefix}${style(status)}`}
  const wrapped = presentation.wrap(status, Math.max(10, presentation.width - 4)).map((part) => `    ${style(part)}`)
  return [prefix.trimEnd(), ...wrapped].join('\n')
}

export function renderShellLsSummary(presentation: Presentation, record: FormatRecord): string {
  const devices = Array.isArray(record.devices) ? record.devices.length : 0
  const unreachable = numberValue(record.unreachableCount)
  const sessions = numberValue(record.sessionCount)
  const parts = [
    `${devices} device${devices === 1 ? '' : 's'}`,
    ...(unreachable > 0 ? [`${unreachable} unreachable`] : []),
    `${sessions} session${sessions === 1 ? '' : 's'}`,
    `${(numberValue(record.elapsedMs) / 1000).toFixed(1)} s`
  ]
  return presentation.style(parts.join(' · '), 'section')
}

export function renderShellLsFooter(presentation: Presentation): string {
  return presentation.wrap(SHELL_LS_FOOTER).map((line) => presentation.style(line, 'muted')).join('\n')
}

/** Whole non-streaming rendering: summary, devices, hint. Stable: no spinners, no cursor control. */
export function renderShellLsStatic(presentation: Presentation, record: FormatRecord, glyphs = false, nowMs = Date.now()): string {
  const devices = Array.isArray(record.devices) ? record.devices.map(asRecord) : []
  const layout = shellLsLayout(devices.map(toIdentity), glyphs, nowMs)
  return [
    renderShellLsSummary(presentation, record),
    '',
    ...devices.map((device) => renderShellLsDevice(presentation, device, layout)),
    '',
    renderShellLsFooter(presentation)
  ].join('\n')
}

export function formatAge(nowMs: number, createdSeconds: unknown): string {
  if (typeof createdSeconds !== 'number' || !Number.isFinite(createdSeconds) || createdSeconds <= 0) {return '-'}
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - createdSeconds))
  if (seconds < 60) {return `${seconds}s`}
  if (seconds < 3600) {return `${Math.floor(seconds / 60)}m`}
  if (seconds < 86_400) {return `${Math.floor(seconds / 3600)}h`}
  return `${Math.floor(seconds / 86_400)}d`
}

function toIdentity(record: FormatRecord): ShellLsDeviceIdentity {
  return {
    device: stringValue(record.device),
    username: stringValue(record.username),
    host: stringValue(record.host),
    port: typeof record.port === 'number' ? record.port : 22,
    default: record.default === true || (Array.isArray(record.profiles) && record.profiles.some((profile) => asRecord(profile).default === true))
  }
}

function usedAt(session: FormatRecord): number {
  return numberValue(session.lastUsed) || numberValue(session.created)
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
