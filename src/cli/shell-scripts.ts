import { shellEscape } from '../ssh/shell-escape'
import {
  buildDevboxShellEnvironmentRefreshScript,
  buildDevboxShellSourceCommand
} from '../core/devbox-credential-env'
import {
  buildDevboxTmuxDefaults,
  buildDevboxTmuxInvocation
} from './shell-tmux'

/** Build the exact remote tmux command after the session name has been validated. */
export function buildDevboxShellAttachCommand(
  sessionName: string,
  remoteCwd: string,
  profileId?: string,
  socketName?: string,
  relay?: { watcherScript: string },
  initialInput?: string
): string {
  const source = profileId === undefined ? '' : ` ${shellEscape(buildDevboxShellSourceCommand(profileId))}`
  const tmux = buildDevboxTmuxInvocation(socketName, true)
  const create = `${tmux} new-session -d -s "$session" -c "$cwd"${source}`
  return [
    'set -e',
    ...(socketName === undefined ? [] : [`socket=${shellEscape(socketName)}`]),
    `session=${shellEscape(sessionName)}`,
    `cwd=${shellEscape(remoteCwd)}`,
    ...buildDevboxSessionEnsureScript(tmux, create, 'cwd', socketName),
    ...(initialInput === undefined ? [] : buildDevboxShellInitialInputScript(tmux, initialInput)),
    ...(relay === undefined ? [] : [`(bash -c ${shellEscape(relay.watcherScript)}) </dev/null >/dev/null 2>&1 &`]),
    `exec ${tmux} attach-session -t "$session"`
  ].join('\n')
}

/**
 * Type `input` into the session's shell exactly once, then press Enter (`shell new --run`).
 * The session option marker is set BEFORE the keys are sent, so the attach script being
 * re-run by the reconnect loop (or racing itself) never types the command twice.
 */
export function buildDevboxShellInitialInputScript(tmux: string, input: string): string[] {
  return [
    `run=${shellEscape(input)}`,
    `if [ -z "$(${tmux} show-options -qv -t "$session" @devbox-run-sent 2>/dev/null)" ]; then`,
    `  ${tmux} set-option -q -t "$session" @devbox-run-sent 1`,
    `  ${tmux} send-keys -t "$session" -l -- "$run"`,
    `  ${tmux} send-keys -t "$session" Enter`,
    'fi'
  ]
}

export function buildDevboxShellCredentialPrepareScript(
  profileId: string,
  sessionName: string,
  remoteRoot: string,
  socketName?: string
): string {
  const source = shellEscape(buildDevboxShellSourceCommand(profileId))
  const tmux = buildDevboxTmuxInvocation(socketName, true)
  const create = `${tmux} new-session -d -s "$session" -c "$root" ${source}`
  return [
    'set -Eeuo pipefail',
    ...(socketName === undefined ? [] : [`socket=${shellEscape(socketName)}`]),
    `session=${shellEscape(sessionName)}`,
    `root=${shellEscape(remoteRoot)}`,
    ...buildDevboxSessionEnsureScript(tmux, create, 'root', socketName),
    buildDevboxShellEnvironmentRefreshScript(profileId, sessionName, socketName)
  ].join('\n')
}

function buildDevboxSessionEnsureScript(
  tmux: string,
  create: string,
  cwdVariable: 'cwd' | 'root',
  socketName?: string
): string[] {
  if (socketName === undefined) {
    return [`if ! ${tmux} has-session -t "$session" 2>/dev/null; then`, `  ${create}`, 'fi']
  }
  const defaults = buildDevboxTmuxDefaults(tmux)
  const cleanup = `${tmux} kill-session -t "$bootstrap" 2>/dev/null || true`
  return [
    `if ${tmux} has-session -t "$session" 2>/dev/null; then`,
    ...defaults.map((command) => `  ${command}`),
    'else',
    '  bootstrap="devbox-bootstrap-$$"',
    `  ${tmux} new-session -d -s "$bootstrap" -c "$${cwdVariable}"`,
    `  trap '${cleanup}' EXIT`,
    ...defaults.map((command) => `  ${command}`),
    `  ${create}`,
    `  ${cleanup}`,
    '  trap - EXIT',
    'fi'
  ]
}
