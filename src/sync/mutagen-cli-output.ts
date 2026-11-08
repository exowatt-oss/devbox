import {
  DEVBOX_SYNC_BACKEND_LABEL,
  DEVBOX_SYNC_PROFILE_LABEL,
  DEVBOX_SYNC_ROOT_CLASS_LABEL,
  DEVBOX_SYNC_SESSION_LABEL
} from './devbox-sync-backend'
import { parseMutagenConflict } from './mutagen-cli-conflict-output'
import { splitMutagenMonitorFrames } from './mutagen-cli-monitor-framing'
import type { MutagenSessionRecord } from './mutagen-cli-types'

function parseLabels(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) {
    return Object.freeze({})
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid session labels')
  }
  const labels: Record<string, string> = {}
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== 'string') {
      throw new Error('invalid session label')
    }
    labels[key] = label
  }
  return Object.freeze(labels)
}

function parseSuccessfulCycles(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function parsePollingInterval(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseLastError(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function parseProblems(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([])
  }
  return Object.freeze(value.map((problem) => {
    if (typeof problem === 'string') {
      return problem
    }
    try {
      const encoded = JSON.stringify(problem)
      return typeof encoded === 'string' ? encoded : String(problem)
    } catch {
      return String(problem)
    }
  }))
}

function parseSession(value: unknown): MutagenSessionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid session')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.identifier !== 'string' || candidate.identifier.length === 0) {
    throw new Error('invalid session identifier')
  }

  const rawConflicts = candidate.conflicts
  if (rawConflicts !== undefined && !Array.isArray(rawConflicts)) {
    throw new Error('invalid session conflicts')
  }
  const conflicts = (rawConflicts ?? []).flatMap((conflict) => parseMutagenConflict(conflict))
  const rawWatch = candidate.watch
  const watch =
    typeof rawWatch === 'object' && rawWatch !== null && !Array.isArray(rawWatch)
      ? (rawWatch as Record<string, unknown>)
      : undefined
  const watchMode = typeof watch?.mode === 'string' ? watch.mode : 'portable'

  return {
    identifier: candidate.identifier,
    name: typeof candidate.name === 'string' ? candidate.name : null,
    labels: parseLabels(candidate.labels),
    paused: candidate.paused === true,
    status: typeof candidate.status === 'string' ? candidate.status : 'unknown',
    successfulCycles: parseSuccessfulCycles(candidate.successfulCycles),
    conflicts: Object.freeze(conflicts),
    lastError: parseLastError(candidate.lastError),
    problems: parseProblems(candidate.problems),
    watch: {
      mode: watchMode,
      pollingInterval: parsePollingInterval(watch?.pollingInterval),
      native: null
    },
    // v0.18.1 does not export these timestamps; null means unobserved.
    lastChangeAt: null,
    lastSynchronizedAt: null
  }
}

export function parseMutagenSessionArray(json: string): readonly MutagenSessionRecord[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) {
    throw new Error('Mutagen state must be a JSON array')
  }
  return Object.freeze(value.map(parseSession))
}

export function isAppOwnedMutagenSession(
  session: MutagenSessionRecord,
  profileId: string
): boolean {
  return (
    session.labels[DEVBOX_SYNC_PROFILE_LABEL] === profileId &&
    session.labels[DEVBOX_SYNC_BACKEND_LABEL] === 'mutagen' &&
    typeof session.labels[DEVBOX_SYNC_SESSION_LABEL] === 'string' &&
    session.labels[DEVBOX_SYNC_SESSION_LABEL].length > 0 &&
    typeof session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] === 'string' &&
    session.labels[DEVBOX_SYNC_ROOT_CLASS_LABEL].length > 0
  )
}

export function parseMutagenMonitorOutput(
  output: string
): readonly (readonly MutagenSessionRecord[])[] {
  return Object.freeze(splitMutagenMonitorFrames(output).map(parseMutagenSessionArray))
}
