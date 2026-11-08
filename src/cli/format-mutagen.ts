import {
  asRecord,
  keyValue,
  section,
  stringValue,
  table,
  type FormatRecord,
  type StageStatus
} from './format-sections'
import type { Presentation } from './presentation'
import {
  describeEndpoint,
  renderDaemonSection,
  renderHints,
  renderHubSection,
  renderServiceSection,
  renderSpokeTable
} from './format-mutagen-sections'

export type MutagenStageRendering = {
  title: string
  status: StageStatus
  body: string[]
  trailing?: string
}

export function renderMutagenStage(
  presentation: Presentation,
  command: string,
  record: FormatRecord
): MutagenStageRendering {
  if (command === 'mutagen status') {return renderStatus(presentation, record)}
  if (command === 'mutagen setup') {return renderSetup(presentation, record)}
  if (command === 'mutagen logs') {return renderLogs(presentation, record)}
  if (command === 'mutagen spokes') {return renderSpokes(presentation, record)}
  if (command === 'mutagen pause') {
    return renderSessionAction(presentation, command, record)
  }
  return renderServiceAction(presentation, command, record)
}

function renderStatus(presentation: Presentation, record: FormatRecord): MutagenStageRendering {
  const daemon = asRecord(record.daemon)
  const service = asRecord(record.service)
  const topology = asRecord(record.topology)
  const sessions = Array.isArray(record.sessions) ? record.sessions.map(asRecord) : []
  const hub = record.hub === null || record.hub === undefined ? null : asRecord(record.hub)
  const body = [renderServiceSection(presentation, record), renderDaemonSection(presentation, record), renderSessionTable(presentation, sessions)]
  const violations = Array.isArray(topology.violations) ? topology.violations.filter((item): item is string => typeof item === 'string') : []
  if (violations.length > 0) {
    body.push(section(presentation, 'Topology violations', violations.map((item) => `- ${item}`).join('\n')))
  }
  body.push(hub === null
    ? mutedLine(presentation, 'Hub registry skipped (no profile or --no-remote).')
    : renderHubSection(presentation, hub))
  const hints = renderHints(presentation, record.hints)
  if (hints) {body.push(hints)}
  const unhealthy = topology.verdict === 'violation' || (service.installed === true && daemon.running === false)
  const warning = daemon.running !== true || (hub !== null && hub.reachable === false)
  return {
    title: 'Devbox Mutagen',
    status: {
      kind: unhealthy ? 'error' : warning ? 'warning' : 'success',
      message: statusMessage(record, sessions.length, topology, hub)
    },
    body
  }
}

function renderSetup(presentation: Presentation, record: FormatRecord): MutagenStageRendering {
  const service = asRecord(record.service)
  const daemon = asRecord(record.daemon)
  const body = [renderServiceSection(presentation, record), renderDaemonSection(presentation, record)]
  const hub = record.hub === null || record.hub === undefined ? null : asRecord(record.hub)
  if (hub === null) {
    body.push(mutedLine(presentation, 'Hub registry skipped (no profile or --no-remote).'))
  } else {
    body.push(renderHubSection(presentation, hub))
  }
  if (typeof record.legacyWrapper === 'string' && record.legacyWrapper) {
    body.push(section(presentation, 'Note', `Legacy wrapper found at ${record.legacyWrapper}; it is no longer used and can be deleted.`))
  }
  const hints = renderHints(presentation, record.hints)
  if (hints) {body.push(hints)}
  const action = stringValue(service.action, 'unchanged')
  return {
    title: 'Devbox Mutagen setup',
    status: daemon.running === true
      ? { kind: 'success', message: `service ${action} · daemon running (${stringValue(daemon.origin)})` }
      : { kind: 'warning', message: `service ${action} · daemon not running` },
    body
  }
}

function renderServiceAction(presentation: Presentation, command: string, record: FormatRecord): MutagenStageRendering {
  const verb = command.slice('mutagen '.length)
  const daemon = asRecord(record.daemon)
  const running = daemon.running === true
  const stopped = verb === 'stop' && !running
  const body = [renderServiceSection(presentation, record), renderDaemonSection(presentation, record)]
  if (typeof record.detail === 'string' && record.detail) {body.push(section(presentation, 'Detail', record.detail))}
  return {
    title: `Devbox Mutagen ${verb}`,
    status: {
      kind: stopped || running ? 'success' : 'warning',
      message: `${running ? 'daemon running' : 'daemon not running'} · via ${stringValue(record.via)}`
    },
    body
  }
}

function renderLogs(presentation: Presentation, record: FormatRecord): MutagenStageRendering {
  const lines = Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === 'string') : []
  const body = [keyValue(presentation, 'Log', {
    path: stringValue(record.logPath),
    exists: record.exists === true ? 'yes' : 'no',
    lines: String(lines.length)
  }), section(presentation, 'Output', lines.length > 0 ? lines.join('\n') : presentation.emptyState('Log file not found.'))]
  return {
    title: 'Devbox Mutagen log',
    status: record.exists === true
      ? { kind: 'success', message: `${lines.length} log line${lines.length === 1 ? '' : 's'}` }
      : { kind: 'warning', message: 'Log file not found' },
    body
  }
}

function renderSessionAction(presentation: Presentation, command: string, record: FormatRecord): MutagenStageRendering {
  const sessions = Array.isArray(record.sessions) ? record.sessions.map(asRecord) : []
  const allOk = sessions.every((session) => session.ok === true)
  const body = [sessions.length === 0
    ? presentation.emptyState('No Devbox-owned Mutagen sessions.')
    : table(presentation, {
      rows: sessions,
      columns: [
        { header: 'SESSION', get: (session) => stringValue(session.name, stringValue(session.identifier)), priority: 10 },
        {
          header: 'RESULT',
          get: (session) => session.ok === true
            ? presentation.style('ok', 'success')
            : presentation.style(stringValue(session.error, 'error'), 'error'),
          priority: 8
        }
      ],
      gap: 2,
      headerStyle: 'section'
    })]
  return {
    title: `Devbox Mutagen ${command.slice('mutagen '.length)}`,
    status: allOk ? { kind: 'success', message: `${command.slice('mutagen '.length)} complete` } : { kind: 'error', message: `${command.slice('mutagen '.length)} failed` },
    body
  }
}

function renderSpokes(presentation: Presentation, record: FormatRecord): MutagenStageRendering {
  const hub = asRecord(record.hub)
  return {
    title: 'Devbox Mutagen spokes',
    status: { kind: hub.reachable === false ? 'warning' : 'success', message: `${Array.isArray(hub.spokes) ? hub.spokes.length : 0} spoke${Array.isArray(hub.spokes) && hub.spokes.length === 1 ? '' : 's'} registered` },
    body: [keyValue(presentation, 'Hub', {
      hub: `${stringValue(hub.user, '')}@${stringValue(hub.host, '')}:${stringValue(hub.root, '')}`,
      hubId: stringValue(hub.hubId),
      reachable: hub.reachable === true ? 'yes' : 'no',
      registered: hub.registered === true ? 'yes' : 'no',
      liveAgents: stringValue(hub.liveAgentCount, 'unknown'),
      spokes: String(Array.isArray(hub.spokes) ? hub.spokes.length : 0)
    }), section(presentation, 'Spokes', renderSpokeTable(presentation, hub))]
  }
}

function renderSessionTable(presentation: Presentation, sessions: readonly FormatRecord[]): string {
  if (sessions.length === 0) {return presentation.emptyState('No Devbox-owned Mutagen sessions.')}
  return section(presentation, 'Sessions', table(presentation, {
    rows: sessions,
    columns: [
      { header: 'SESSION', get: (session) => stringValue(session.name, stringValue(session.identifier)), priority: 10 },
      { header: 'STATUS', get: (session) => session.paused === true ? 'paused' : stringValue(session.status), priority: 9 },
      { key: 'successfulCycles', header: 'CYCLES', priority: 8, align: 'right' },
      { key: 'conflictCount', header: 'CONFLICTS', priority: 7, align: 'right' },
      { key: 'problemCount', header: 'PROBLEMS', priority: 6, align: 'right' },
      { header: 'ENDPOINTS', get: (session) => `${describeEndpoint(session.alpha)} → ${describeEndpoint(session.beta)}`, optional: true, priority: 4 },
      {
        header: 'TOPOLOGY',
        get: (session) => session.topology === 'violation'
          ? presentation.style('VIOLATION', 'error')
          : presentation.style('spoke→hub', 'success'),
        priority: 3
      }
    ],
    gap: 2,
    headerStyle: 'section'
  }))
}

function statusMessage(
  record: FormatRecord,
  sessionCount: number,
  topology: FormatRecord,
  hub: FormatRecord | null
): string {
  const daemon = asRecord(record.daemon)
  const daemonText = daemon.running === true
    ? `daemon running${daemon.origin && daemon.origin !== 'unknown' && daemon.origin !== 'none' ? ` (${daemon.origin}${typeof daemon.pid === 'number' ? ` · pid ${daemon.pid}` : ''})` : ''}`
    : 'daemon not running'
  const parts = [daemonText, `${sessionCount} session${sessionCount === 1 ? '' : 's'}`]
  if (typeof topology.verdict === 'string') {parts.push(`topology ${topology.verdict === 'ok' ? 'ok' : topology.verdict}`)}
  if (hub) {
    parts.push(hub.reachable === false ? 'hub unreachable' : hub.registered === true ? 'hub registered' : 'hub not registered')
    parts.push(`${Array.isArray(hub.spokes) ? hub.spokes.length : 0} spoke${Array.isArray(hub.spokes) && hub.spokes.length === 1 ? '' : 's'}`)
  }
  return parts.join(' · ')
}

function mutedLine(presentation: Presentation, text: string): string {
  return presentation.wrap(text).map((line) => presentation.style(line, 'muted')).join('\n')
}
