import { shellEscape } from '../ssh/shell-escape'
import type { DevboxShellListResult } from './shell-sessions'
import { buildDevboxShellListResult, parseOwnedDevboxShellOutput, type OwnedShell } from './shell-lifecycle'
import { buildDevboxTmuxInvocation, devboxShellSocketName, type DevboxShellSocket } from './shell-tmux'

/**
 * One-round-trip `shell ls` probe. A single remote script reports, for every
 * profile that shares one SSH endpoint, each profile's private tmux socket plus
 * the default socket once. It is read-only: unlike attach/new it never installs
 * tmux (a host without tmux simply has no shells).
 */
const MARKER = '@@devbox-probe'
const DEFAULT_SOCKET_TOKEN = '-'
// The pane path comes FIRST so the remaining fields keep the exact
// `buildDevboxShellListCommand` row shape (title is the tab-joined remainder).
const PROBE_FORMAT = '#{pane_current_path}\t#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_title}'

export type DevboxShellProbeParse = {
  tmux: boolean
  results: Map<string, DevboxShellListResult>
}

export function buildDevboxShellProbeScript(profileIds: readonly string[]): string {
  const sockets: DevboxShellSocket[] = [...profileIds.map((id) => devboxShellSocketName(id)), undefined]
  const lines = [
    `if ! command -v tmux >/dev/null 2>&1; then printf '%s\\n' '${MARKER} no-tmux'; exit 0; fi`
  ]
  for (const socket of sockets) {
    lines.push(
      `printf '%s\\n' '${MARKER} socket ${socket ?? DEFAULT_SOCKET_TOKEN}'`,
      `${buildDevboxTmuxInvocation(socket, false)} list-sessions -F ${shellEscape(PROBE_FORMAT)} 2>/dev/null || true`
    )
  }
  lines.push(`printf '%s\\n' '${MARKER} end'`)
  return lines.join('\n')
}

/** The remote command line for the probe; `sh -c` keeps it POSIX whatever the login shell is. */
export function buildDevboxShellProbeCommand(profileIds: readonly string[]): string {
  return `sh -c ${shellEscape(buildDevboxShellProbeScript(profileIds))}`
}

export function parseDevboxShellProbeOutput(profileIds: readonly string[], stdout: string): DevboxShellProbeParse {
  const sections = new Map<string, string[]>()
  let current: string[] | undefined
  let tmux = true
  let complete = false
  for (const line of stdout.split('\n')) {
    if (line.startsWith(`${MARKER} `)) {
      const [kind, value] = line.slice(MARKER.length + 1).trim().split(' ')
      if (kind === 'no-tmux') {
        tmux = false
        complete = true
      } else if (kind === 'end') {
        complete = true
      } else if (kind === 'socket' && value !== undefined) {
        current = []
        sections.set(value, current)
      }
      continue
    }
    current?.push(line)
  }
  if (!complete) {
    throw new Error('shell probe output was truncated (no end marker)')
  }
  const defaultSection = sections.get(DEFAULT_SOCKET_TOKEN) ?? []
  const results = new Map<string, DevboxShellListResult>()
  for (const profileId of profileIds) {
    const socket = devboxShellSocketName(profileId)
    const owned = [
      ...parseSection(profileId, sections.get(socket) ?? [], socket),
      ...parseSection(profileId, defaultSection, undefined)
    ]
    results.set(profileId, buildDevboxShellListResult(profileId, owned))
  }
  return { tmux, results }
}

function parseSection(profileId: string, lines: readonly string[], socket: DevboxShellSocket): OwnedShell[] {
  const cwdBySession = new Map<string, string>()
  const rows: string[] = []
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab < 0) {continue}
    const row = line.slice(tab + 1)
    cwdBySession.set(row.split('\t', 1)[0] ?? '', line.slice(0, tab))
    rows.push(row)
  }
  return parseOwnedDevboxShellOutput(profileId, rows.join('\n'), socket).map((shell) => {
    if (!shell.canonical) {return shell}
    const cwd = cwdBySession.get(shell.session.sessionName)
    return cwd ? { ...shell, session: { ...shell.session, cwd } } : shell
  })
}
