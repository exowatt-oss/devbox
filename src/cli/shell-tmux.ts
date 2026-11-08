import { createHash } from 'node:crypto'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import { shellEscape } from '../ssh/shell-escape'

export const DEVBOX_SHELL_INSTALL_COMMAND =
  'sudo -n apt-get install -y --no-install-recommends tmux'
export const DEVBOX_DARWIN_SHELL_INSTALL_COMMAND = 'brew install tmux'

export type TmuxOutput = (line: string) => void

export async function ensureDevboxTmux(
  runner: DevboxSshRunner,
  output: TmuxOutput = (line) => console.error(line),
  timeoutMs?: number
): Promise<void> {
  try {
    if ((await runner.command('command -v tmux', timeoutMs)).trim().length > 0) {
      return
    }
  } catch (error) {
    // A missing command exits non-zero. Probe passwordless sudo before deciding
    // whether the operator has a non-interactive installation path. A transport
    // failure (ssh exit 255 or a timeout) is not a missing tmux: report it as is.
    if (isTransportFailure(error)) {throw error}
  }

  let installCommand = DEVBOX_SHELL_INSTALL_COMMAND
  try {
    const platform = await runner.command('uname -s')
    if (platform.trim() === 'Darwin') {
      installCommand = DEVBOX_DARWIN_SHELL_INSTALL_COMMAND
    } else {
      await runner.command('sudo -n true')
    }
  } catch {
    throw new Error(
      `tmux is not installed and passwordless sudo is unavailable. Install it with: ${installCommand}`
    )
  }

  output(`tmux not found; installing with: ${installCommand}`)
  try {
    await runner.command(installCommand)
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`tmux installation failed${detail}; install with: ${installCommand}`)
  }

  try {
    if ((await runner.command('command -v tmux')).trim().length > 0) {
      return
    }
  } catch {
    // Fall through to the same actionable remediation.
  }
  throw new Error(
    `tmux installation completed but tmux is still unavailable. Install it with: ${installCommand}`
  )
}

export type DevboxShellSocket = string | undefined

function isTransportFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {return false}
  const { exitCode, timedOut } = error as { exitCode?: unknown; timedOut?: unknown }
  return exitCode === 255 || timedOut === true
}

const DEVBOX_TMUX_STATUS_LEFT =
  '#[fg=#67e8f9,bold] DEVBOX #[fg=#94a3b8]#{host_short} #[fg=#475569]·#[fg=#e2e8f0] #S'
const DEVBOX_TMUX_WINDOW_STATUS =
  '#[fg=#64748b] #I #[fg=#94a3b8]#W '
const DEVBOX_TMUX_CURRENT_WINDOW_STATUS =
  '#[fg=#0f172a,bg=#67e8f9,bold] #I:#W #[fg=#cbd5e1,bg=#111827]'
const DEVBOX_TMUX_STATUS_RIGHT =
  '#[fg=#94a3b8]#{?pane_in_mode, COPY ,#{?client_prefix, PREFIX , READY }}#[fg=#f8fafc]#{pane_current_command} #[fg=#475569]·#[fg=#cbd5e1]#{=-40:pane_current_path} #[fg=#475569]·#[fg=#fbbf24]%H:%M'

/** tmux's stock xterm* feature entry; `title` makes tmux emit client titles for `TERM=xterm*`. */
export const DEVBOX_TMUX_XTERM_FEATURES = 'xterm*:clipboard:ccolour:cstyle:focus:title'

/** Return the stable private tmux socket for a profile's UTF-8 id. */
export function devboxShellSocketName(profileId: string): string {
  const digest = createHash('sha256').update(profileId, 'utf8').digest('hex').slice(0, 12)
  return `devbox-${digest}`
}

export function buildDevboxTmuxInvocation(socketName: DevboxShellSocket, useVariable: boolean): string {
  if (socketName === undefined) {return 'tmux'}
  return useVariable
    ? 'tmux -f /dev/null -L "$socket"'
    : `tmux -f /dev/null -L ${shellEscape(socketName)}`
}

/**
 * Private-server defaults. This deliberately leaves keyboard and middle-click
 * bindings stock; only wheel/drag guards, copy-mode wheel routing, and drag
 * release are explicit so tmux 3.4 keeps its normal input contract.
 */
export function buildDevboxTmuxDefaults(tmux: string): string[] {
  const mouseGuard = '#{||:#{pane_in_mode},#{mouse_any_flag}}'
  return [
    `${tmux} set-option -g extended-keys on 2>/dev/null || ${tmux} set-option -s extended-keys on`,
    `${tmux} set-option -g mouse on 2>/dev/null || ${tmux} set-option -s mouse on`,
    `${tmux} set-option -g history-limit 100000`,
    `${tmux} set-option -g set-clipboard on`,
    // A plain `set terminal-features X` REPLACES tmux's array (0.6.8 left only a no-op
    // `clipboard` entry, which disabled clipboard and title support for xterm*). Restore the
    // stock entries, then pin the xterm* one: it gives the client the title capability.
    `${tmux} set-option -su terminal-features 2>/dev/null || true`,
    `${tmux} set-option -sa terminal-features '${DEVBOX_TMUX_XTERM_FEATURES}' 2>/dev/null || true`,
    // Forward the pane title (e.g. remote phi's `π …`) to the outer terminal verbatim.
    `${tmux} set-option -g set-titles on`,
    `${tmux} set-option -g set-titles-string '#{pane_title}'`,
    `${tmux} bind-key -n WheelUpPane if-shell -F '${mouseGuard}' 'send-keys -M' 'copy-mode -e'`,
    `${tmux} bind-key -n WheelDownPane if-shell -F '${mouseGuard}' 'send-keys -M' 'copy-mode -e'`,
    `${tmux} bind-key -n MouseDrag1Pane if-shell -F '${mouseGuard}' 'send-keys -M' 'copy-mode -M'`,
    `${tmux} bind-key -T copy-mode WheelUpPane select-pane -t = '\\;' send-keys -X -N 5 scroll-up`,
    `${tmux} bind-key -T copy-mode WheelDownPane select-pane -t = '\\;' send-keys -X -N 5 scroll-down`,
    `${tmux} bind-key -T copy-mode-vi WheelUpPane select-pane -t = '\\;' send-keys -X -N 5 scroll-up`,
    `${tmux} bind-key -T copy-mode-vi WheelDownPane select-pane -t = '\\;' send-keys -X -N 5 scroll-down`,
    `${tmux} bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel`,
    `${tmux} bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel`,
    `${tmux} set-option -g status on`,
    `${tmux} set-option -g status-interval 1`,
    `${tmux} set-option -g status-style 'bg=#111827,fg=#cbd5e1'`,
    `${tmux} set-option -g message-style 'bg=#1e293b,fg=#e2e8f0'`,
    `${tmux} set-option -g status-left-length 90`,
    `${tmux} set-option -g status-right-length 140`,
    `${tmux} set-option -g status-justify left`,
    `${tmux} set-option -g status-left '${DEVBOX_TMUX_STATUS_LEFT}'`,
    `${tmux} set-option -g window-status-format '${DEVBOX_TMUX_WINDOW_STATUS}'`,
    `${tmux} set-option -g window-status-current-format '${DEVBOX_TMUX_CURRENT_WINDOW_STATUS}'`,
    `${tmux} set-option -g status-right '${DEVBOX_TMUX_STATUS_RIGHT}'`
  ]
}

export function buildDevboxShellListCommand(socketName?: string): string {
  const format = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_title}'
  const tmux = buildDevboxTmuxInvocation(socketName, false)
  return `${tmux} list-sessions -F ${shellEscape(format)} 2>/dev/null || true`
}

export function buildDevboxShellKillCommand(
  sessionName: string,
  socketName?: string,
  tolerateMissing = false
): string {
  const tmux = buildDevboxTmuxInvocation(socketName, false)
  const command = `${tmux} kill-session -t ${shellEscape(sessionName)}`
  return tolerateMissing ? `${command} 2>/dev/null || true` : command
}
