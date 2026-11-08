import { asRecord, keyValue, section, stringValue, table, type FormatRecord } from './format-sections'
import type { Presentation } from './presentation'

export function renderServiceSection(presentation: Presentation, record: FormatRecord): string {
  const service = asRecord(record.service)
  return keyValue(presentation, 'Service', {
    manager: stringValue(service.manager),
    label: stringValue(service.label),
    installed: yesNo(service.installed),
    loaded: yesNo(service.loaded),
    running: yesNo(service.running),
    pid: stringValue(service.pid, 'none'),
    unit: stringValue(service.unitPath),
    log: stringValue(service.logPath),
    ...(typeof service.detail === 'string' && service.detail ? { detail: service.detail } : {})
  })
}

export function renderDaemonSection(presentation: Presentation, record: FormatRecord): string {
  const daemon = asRecord(record.daemon)
  const binary = asRecord(record.binary)
  return keyValue(presentation, 'Daemon', {
    binary: stringValue(binary.path, stringValue(daemon.binaryPath)),
    version: stringValue(binary.version, stringValue(daemon.version)),
    dataDirectory: stringValue(binary.dataDirectory, stringValue(daemon.dataDirectory)),
    origin: stringValue(daemon.origin),
    pid: stringValue(daemon.pid, 'none'),
    lastCycle: formatLastCycle(daemon.lastCycleAt)
  })
}

export function renderHubSection(presentation: Presentation, record: FormatRecord): string {
  const hub = record.hubId !== undefined || record.spokes !== undefined ? record : asRecord(record.hub)
  const spokes = Array.isArray(hub.spokes) ? hub.spokes.map(asRecord) : []
  const summary = keyValue(presentation, 'Hub', {
    hub: describeHub(hub),
    hubId: stringValue(hub.hubId),
    reachable: yesNo(hub.reachable),
    registered: yesNo(hub.registered),
    liveAgents: stringValue(hub.liveAgentCount, 'unknown'),
    spokes: String(spokes.length)
  })
  const spokeTable = spokes.length === 0
    ? presentation.emptyState('No registered spokes.')
    : table(presentation, {
      rows: spokes,
      columns: [
        {
          header: 'SPOKE',
          get: (spoke) => `${spoke.spokeId === hub.thisSpokeId ? '* ' : '  '}${stringValue(spoke.spokeId)}`,
          priority: 10
        },
        { key: 'hostname', header: 'HOST', priority: 8 },
        { key: 'platform', header: 'PLATFORM', priority: 7 },
        { key: 'profileId', header: 'PROFILE', optional: true, priority: 5 },
        { key: 'localRoot', header: 'LOCAL ROOT', optional: true, priority: 3 },
        { key: 'lastSeenAt', header: 'LAST SEEN', optional: true, priority: 6 }
      ],
      gap: 2,
      headerStyle: 'section'
    })
  return `${summary}\n${presentation.section('Spokes')}\n${spokeTable}`
}

export function renderHints(presentation: Presentation, value: unknown): string | undefined {
  const hints = Array.isArray(value) ? value.filter((hint): hint is string => typeof hint === 'string' && hint.length > 0) : []
  return hints.length === 0 ? undefined : section(presentation, 'Hints', hints.map((hint) => `- ${hint}`).join('\n'))
}

export function renderSpokeTable(presentation: Presentation, hubValue: unknown): string {
  const candidate = asRecord(hubValue)
  const hub = candidate.hubId !== undefined || candidate.spokes !== undefined ? candidate : asRecord(candidate.hub)
  const spokes = Array.isArray(hub.spokes) ? hub.spokes.map(asRecord) : []
  return spokes.length === 0
    ? presentation.emptyState('No registered spokes.')
    : table(presentation, {
      rows: spokes,
      columns: [
        {
          header: 'SPOKE',
          get: (spoke) => `${spoke.spokeId === hub.thisSpokeId ? '* ' : '  '}${stringValue(spoke.spokeId)}`,
          priority: 10
        },
        { key: 'hostname', header: 'HOST', priority: 8 },
        { key: 'platform', header: 'PLATFORM', priority: 7 },
        { key: 'profileId', header: 'PROFILE', optional: true, priority: 5 },
        { key: 'localRoot', header: 'LOCAL ROOT', optional: true, priority: 3 },
        { key: 'lastSeenAt', header: 'LAST SEEN', optional: true, priority: 6 }
      ],
      gap: 2,
      headerStyle: 'section'
    })
}

export function describeHub(hub: FormatRecord): string {
  const user = stringValue(hub.user, '')
  const host = stringValue(hub.host, '')
  const root = stringValue(hub.root, '')
  const target = `${user && host ? `${user}@${host}` : host || user}${root ? `:${root}` : ''}`
  return target || 'unknown'
}

export function describeEndpoint(value: unknown): string {
  const endpoint = asRecord(value)
  const path = stringValue(endpoint.path, '')
  const protocol = stringValue(endpoint.protocol, '')
  if (protocol === 'local' || (!endpoint.host && !endpoint.user)) {
    return path || 'unknown'
  }
  const user = stringValue(endpoint.user, '')
  const host = stringValue(endpoint.host, '')
  const target = user && host ? `${user}@${host}` : host || user || 'unknown'
  return path ? `${target}:${path}` : target
}

export function formatLastCycle(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'unknown'
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return 'unknown'
  }
  return `${date.toISOString()} (${Math.max(0, Math.floor((Date.now() - value) / 1000))}s ago)`
}

export function yesNo(value: unknown): string {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown'
}
