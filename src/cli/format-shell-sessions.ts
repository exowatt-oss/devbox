import {
  asRecord,
  formatShellTimestamp,
  keyValue,
  section,
  stringValue,
  table,
  type FormatRecord,
  type StageStatus
} from './format-sections'
import type { Presentation } from './presentation'

export type ShellSessionsStageRendering = {
  body: string[]
  status: StageStatus
  title?: string
}

export function renderShellSessionsStage(
  presentation: Presentation,
  command: string,
  record: FormatRecord
): ShellSessionsStageRendering {
  if (command === 'shell ls') {
    return renderList(presentation, record)
  }
  const bulk = command !== 'shell rm'
  const body = [keyValue(
    presentation,
    bulk ? 'Shell sessions' : 'Shell session',
    bulk
      ? {
        profile: stringValue(record.profileId),
        sessions: stringValue(record.count, '0'),
        killed: record.killed === true ? 'yes' : 'no'
      }
      : {
        profile: stringValue(record.profileId),
        session: stringValue(record.sessionName),
        killed: record.killed === true ? 'yes' : 'no'
      }
  )]
  if (typeof record.detachedHint === 'string') {
    body.push(presentation.style(record.detachedHint, 'muted'))
  }
  return {
    body,
    status: record.killed === true
      ? { kind: 'success', message: bulk ? 'Shell sessions closed' : 'Shell session closed' }
      : { kind: 'warning', message: bulk ? 'Shell sessions were not closed' : 'Shell session was not closed' }
  }
}

function renderList(presentation: Presentation, record: FormatRecord): ShellSessionsStageRendering {
  const sessions = Array.isArray(record.sessions) ? record.sessions.map(asRecord) : []
  const body: string[] = [keyValue(presentation, 'Profile', { profile: stringValue(record.profileId) })]
  if (sessions.length === 0) {
    body.push(presentation.emptyState('No shell sessions.'))
  } else {
    body.push(section(
      presentation,
      'Sessions',
      table(presentation, {
        rows: sessions,
        columns: [
          {
            header: 'ID',
            get: (session) => `${session.mostRecent === true ? '* ' : '  '}${stringValue(session.id)}`,
            priority: 10
          },
          { key: 'name', header: 'NAME', optional: true, priority: 7 },
          { key: 'created', header: 'CREATED (UTC)', format: (value) => formatShellTimestamp(value), priority: 9 },
          {
            header: 'STATUS',
            get: (session) => session.attached === true
              ? presentation.style('LIVE', 'success')
              : presentation.style('idle', 'muted'),
            optional: true,
            priority: 8
          },
          { key: 'lastUsed', header: 'LAST USED (UTC)', format: (value) => formatShellTimestamp(value), optional: true, priority: 4 },
          {
            header: 'COMMAND/TITLE',
            get: (session) => [
              stringValue(session.currentCommand, 'unknown'),
              stringValue(session.currentTitle, '')
            ].filter((part) => part.length > 0).join(' / '),
            optional: true,
            priority: 1
          }
        ],
        gap: 2,
        headerStyle: 'section'
      })
    ))
  }
  return {
    title: 'Devbox shell sessions',
    body,
    status: sessions.length > 0
      ? { kind: 'success', message: `${sessions.length} shell session${sessions.length === 1 ? '' : 's'} · most recent #${stringValue(record.mostRecentId, 'none')}` }
      : { kind: 'muted', message: 'No shell sessions' }
  }
}
