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

export type WorkspaceStageRendering = {
  title: string
  status: StageStatus
  body: string[]
  trailing?: string
}

export function renderWorkspaceStage(
  presentation: Presentation,
  command: string,
  record: FormatRecord
): WorkspaceStageRendering {
  const status = stringValue(record.status, 'failed')
  const steps = Array.isArray(record.steps) ? record.steps.map(asRecord) : []
  const body = [
    keyValue(presentation, 'Workspace', {
      profile: stringValue(record.profileId),
      host: `${stringValue(record.user)}@${stringValue(record.host)}:${stringValue(record.port)}`,
      localRoot: stringValue(record.localRoot),
      remoteRoot: stringValue(record.remoteRoot),
      fingerprint: stringValue(record.fingerprint, 'unpinned')
    }),
    section(presentation, 'Steps', renderSteps(presentation, steps))
  ]
  const nextSteps = Array.isArray(record.nextSteps)
    ? record.nextSteps.filter((step): step is string => typeof step === 'string' && step.length > 0)
    : []
  if (nextSteps.length > 0) {
    body.push(section(presentation, 'Next steps', nextSteps.map((step) => `- ${step}`).join('\n')))
  }
  return {
    title: command === 'init' ? 'Devbox init' : 'Devbox connect',
    status: workspaceStatus(status, record, steps),
    body,
    ...(nextSteps.length > 0 ? { trailing: nextSteps[0] } : {})
  }
}

function workspaceStatus(
  status: string,
  record: FormatRecord,
  steps: readonly FormatRecord[]
): StageStatus {
  if (status === 'ready') {
    return {
      kind: 'success',
      message: `workspace ready · ${stringValue(record.profileId)} ↔ ${stringValue(record.user)}@${stringValue(record.host)}:${stringValue(record.remoteRoot)}`
    }
  }
  if (status === 'blocked') {
    const attention = steps.filter((step) => step.status === 'warning' || step.status === 'failed').length
    return { kind: 'warning', message: `profile saved but not paired · ${attention} step(s) need attention` }
  }
  const failed = steps.find((step) => step.status === 'failed')
  return { kind: 'error', message: `stopped at ${stringValue(failed?.id, 'unknown')}` }
}

function renderSteps(presentation: Presentation, steps: readonly FormatRecord[]): string {
  if (steps.length === 0) { return presentation.emptyState('No bootstrap steps reported.') }
  return table(presentation, {
    rows: steps,
    columns: [
      { key: 'id', header: 'STEP', priority: 10 },
      {
        header: 'STATUS',
        get: (step) => {
          const value = stringValue(step.status)
          const kind = value === 'ok' ? 'success' : value === 'skipped' ? 'muted' : value === 'warning' ? 'warning' : 'error'
          return presentation.style(value === 'ok' ? 'ok' : value, kind)
        },
        priority: 8
      },
      { key: 'detail', header: 'DETAIL', optional: true, priority: 1 }
    ],
    gap: 2,
    headerStyle: 'section'
  })
}
