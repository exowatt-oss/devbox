import type {
  KeyValueEntry,
  Presentation,
  TableColumn,
  StatusKind
} from './presentation'

export type FormatRecord = Record<string, unknown>

export type StageStatus = { readonly kind: StatusKind; readonly message: string }

export type HumanTableOptions = {
  readonly rows: readonly FormatRecord[]
  readonly columns: readonly TableColumn<FormatRecord>[]
  readonly gap?: number
  readonly headerStyle?: 'section' | false
}

export function section(presentation: Presentation, title: string, content: string): string {
  const boundedContent = content.split('\n')
    .flatMap((line) => presentation.wrap(line))
    .join('\n')
  return `${presentation.section(title)}\n${boundedContent}`
}

export function keyValue(
  presentation: Presentation,
  title: string,
  entries: Readonly<Record<string, unknown>> | readonly KeyValueEntry[]
): string {
  return section(presentation, title, presentation.keyValue(entries))
}

export function table(presentation: Presentation, options: HumanTableOptions): string {
  return presentation.table(options)
}

export function asRecord(value: unknown): FormatRecord {
  return isRecord(value) ? value : {}
}

export function isRecord(value: unknown): value is FormatRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback
}

const UTC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export function formatShellTimestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '-'
  }
  const date = new Date(value * 1000)
  if (!Number.isFinite(date.getTime())) {
    return '-'
  }
  const month = UTC_MONTHS[date.getUTCMonth()]
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  return `${month} ${day} ${hour}:${minute}`
}

export function formatShape(value: Record<string, string | boolean>): string {
  return `{ ${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${key}: ${item}`)
    .join(', ')} }`
}

export function statusKind(value: string): StatusKind {
  const normalized = value.toLowerCase()
  if (/error|failed|fault|conflict/iu.test(normalized)) {return 'error'}
  if (/degraded|warn|paused|offline/iu.test(normalized)) {return 'warning'}
  if (/ready|running|complete|success|ok|active/iu.test(normalized)) {return 'success'}
  return 'info'
}

export function resultStatus(record: FormatRecord, command: string): StageStatus {
  const state = stringValue(record.state, stringValue(record.status, ''))
  const normalized = state.toLowerCase()
  const kind: StatusKind = /error|failed|fault|conflict/iu.test(normalized)
    ? 'error'
    : /degraded|warn|paused|offline/iu.test(normalized)
      ? 'warning'
      : /ready|running|complete|success|ok|active/iu.test(normalized)
        ? 'success'
        : state
          ? 'info'
          : 'success'
  return { kind, message: state ? `${humanize(command)} · ${state}` : 'Operation completed' }
}

export function commandTitle(command: string): string {
  const titles: Record<string, string> = {
    'jobs status': 'Devbox job status',
    'jobs cancel': 'Devbox job cancellation',
    'jobs log': 'Devbox job log',
    'ports open': 'Devbox port forward',
    'profile create': 'Devbox profile enrollment',
    'profile use': 'Devbox default profile',
    'profile list': 'Devbox profiles',
    'shell ls': 'Devbox shell sessions',
    'shell rm': 'Devbox shell session',
    'shell rm --all': 'Devbox shell sessions',
    'shell rm --unattached': 'Devbox shell sessions'
  }
  return titles[command] ?? `Devbox ${humanize(command)}`
}

function humanize(value: string): string {
  return value.split(/\s+/u)
    .map((word) => word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word)
    .join(' ')
}

export function syncSection(presentation: Presentation, sync: FormatRecord): string {
  const state = stringValue(sync.state)
  const sessions = Array.isArray(sync.sessions) ? sync.sessions.map(asRecord) : []
  const parts = [
    presentation.status(statusKind(state), `sync: ${state}`),
    presentation.keyValue({
      capability: stringValue(sync.capability),
      watchMode: stringValue(sync.watchMode),
      conflicts: stringValue(sync.conflictCount, '0'),
      problems: syncProblemCount(sync),
      ...(sync.degradation === undefined ? {} : { degradation: sync.degradation })
    })
  ]

  if (sessions.length === 0) {
    parts.push(presentation.emptyState('No synchronization sessions.'))
  } else {
    const rows = sessions.map((session) => {
      const identity = asRecord(session.session)
      return {
        session: stringValue(identity.name, stringValue(identity.sessionId, 'session')),
        phase: stringValue(session.phase),
        conflicts: stringValue(session.conflictCount, '0'),
        problems: stringValue(session.problemCount, '0'),
        error: typeof session.lastError === 'string' ? session.lastError : ''
      }
    })
    parts.push(
      section(
        presentation,
        'Sessions',
        table(presentation, {
          rows,
          columns: [
            { key: 'session', header: 'SESSION', priority: 10 },
            { key: 'phase', header: 'PHASE', priority: 9 },
            { key: 'conflicts', header: 'CONFLICTS', priority: 8, align: 'right' },
            { key: 'problems', header: 'PROBLEMS', priority: 8, align: 'right' },
            { key: 'error', header: 'ERROR', optional: true, priority: 1 }
          ],
          gap: 2,
          headerStyle: 'section'
        })
      )
    )
    const lastErrors = sessions.flatMap((session) => {
      if (typeof session.lastError !== 'string' || session.lastError.length === 0) {
        return []
      }
      const identity = asRecord(session.session)
      const name = stringValue(identity.name, stringValue(identity.sessionId, 'session'))
      return [`${name}: ${session.lastError}`]
    })
    if (lastErrors.length > 0) {
      parts.push(section(
        presentation,
        'Last error',
        lastErrors.map((error) => presentation.wrap(error).join('\n')).join('\n')
      ))
    }
  }

  return section(presentation, 'Synchronization', parts.join('\n'))
}

function syncProblemCount(sync: FormatRecord): string {
  const sessions = Array.isArray(sync.sessions) ? sync.sessions : []
  const count = sessions.reduce((sum, item) => {
    const problemCount = asRecord(item).problemCount
    return sum + (typeof problemCount === 'number' ? problemCount : 0)
  }, 0)
  return String(count)
}

export function roamingSection(presentation: Presentation, roaming: FormatRecord): string {
  const state = `${stringValue(roaming.owner)} authority, ${stringValue(roaming.transition)} (${stringValue(roaming.repositories)} repositories)`
  const warnings = Array.isArray(roaming.warnings) ? roaming.warnings.map(asRecord) : []
  const parts = [
    presentation.status(statusKind(stringValue(roaming.transition)), `git roaming: ${state}`),
    presentation.keyValue({
      topology: 'working-tree-only',
      localGit: stringValue(roaming.localGit),
      remoteGit: stringValue(roaming.remoteGit),
      dirty: stringValue(roaming.dirtyRepositories, '0'),
      unpublished: stringValue(roaming.unpublishedRepositories, '0'),
      witnesses: stringValue(roaming.witnesses)
    })
  ]

  if (warnings.length > 0) {
    parts.push(
      presentation.section(`Warnings (${warnings.length})`),
      ...warnings.slice(0, 8).flatMap((warning) => presentation.wrap(
        `${stringValue(warning.repository, 'profile')}: ${stringValue(warning.message)}`
      ))
    )
  } else {
    parts.push(presentation.emptyState('No Git-roaming warnings.'))
  }

  parts.push(presentation.wrap(
    'Private .git metadata · working-tree-only sync · fencing: cooperative'
  ).map((line) => presentation.style(line, 'muted')).join('\n'))
  return section(presentation, 'Git roaming', parts.join('\n'))
}

export function renderResult(
  presentation: Presentation,
  title: string,
  status: { readonly kind: StatusKind; readonly message: string },
  body: readonly string[],
  operationId: string,
  trailing?: string
): string {
  const operationLines = presentation.wrap(`operationKey: ${operationId}`)
    .map((line) => presentation.style(line, 'muted'))
  const trailingLines = trailing === undefined
    ? []
    : ['', ...presentation.wrap(trailing).map((line) => presentation.style(line, 'accent'))]
  return [
    presentation.title(title),
    presentation.status(status.kind, status.message),
    ...body.flatMap((item) => ['', item]),
    '',
    ...operationLines,
    ...trailingLines
  ].join('\n')
}
