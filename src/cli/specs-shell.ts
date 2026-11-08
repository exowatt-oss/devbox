import type { CommandSpec } from './args'

const SHELL_COMMON = ['profile', 'device', 'operation-key']

/** `devbox shell` help surface; kept apart from specs.ts so that file stays under the line budget. */
export const SHELL_COMMAND_SPEC: CommandSpec = {
  path: ['shell'],
  summary: 'Manage persistent tmux shells on the Devbox host',
  usage: 'devbox shell [<id-or-name>] [--no-reconnect] [--no-login-relay] [--profile <id>|--device <name>] | new [name] [--cwd <remote-dir>] [--run <command>] [--no-reconnect] [--no-login-relay] [--profile <id>|--device <name>] | resume [--no-reconnect] [--no-login-relay] [--profile <id>|--device <name>] | reconnect [--all [--dry-run] [--worktree <selector>]] | ls [--device <name>] [--refresh] | rm <id-or-name> | rm this | rm --all | rm --unattached [--all-devices]',
  allowedFlags: [...SHELL_COMMON, 'name', 'list', 'kill', 'all', 'all-devices', 'unattached', 'cwd', 'run', 'no-reconnect', 'no-login-relay', 'dry-run', 'worktree', 'refresh'],
  notes: [
    'Detach with Ctrl-b d; closing the terminal window is equally safe.',
    'Without --profile/--device, ls shows every configured device (profiles sharing one SSH endpoint are grouped under that device) and a target is looked up across devices; a unique match on another device is used automatically.',
    'ls probes each SSH endpoint once, in parallel, in one round trip (3 s connect / 5 s cap; 10 s through a ProxyCommand, longer while it wakes a stopped box). A device that just failed is skipped for 60 s; --refresh probes it anyway.',
    'rm this closes only the current Devbox-owned tmux session, works on any hub and needs no profile; rm --unattached closes only detached sessions for the selected profile (add --all-devices to sweep every device).',
    'While attached, OAuth logins started on the hub (e.g. optional phi `/login anthropic` or Codex) complete from the local browser: the callback on localhost:53692/1455/1456 is relayed to the hub only while a login is in progress; `--no-login-relay` or `DEVBOX_SHELL_LOGIN_RELAY=0` disables it.',
    'On connection loss (ssh exit 255) the attach offers an in-place reconnect: [Enter] retries now, [q] quits; pass --no-reconnect or set DEVBOX_SHELL_RECONNECT=0 to opt out.',
    'new --run <command> types <command> into the fresh login shell once, as if typed and followed by Enter (aliases resolve; the shell stays after the program exits); one line, at most 4096 bytes, new only.',
    'Optional Forca terminal-host integration: reconnect --all opens one titled tab per detached session on every device shell ls lists (or only --profile/--device), attached by tmux session name (needs the forca CLI + running app); this terminal resumes its own last session in place.'
  ],
  examples: [
    'devbox shell             # attach to the most recently used (or create session 1)',
    'devbox shell new agents  # create and attach a fresh named session',
    'devbox shell new review --run "git status"  # fresh session that runs a command, then attach',
    'devbox shell resume        # re-attach to the session this terminal last used',
    'devbox shell reconnect --all  # optional Forca tabs; --dry-run shows the plan',
    'devbox shell ls          # every device, grouped; * marks the most recent session',
    'devbox shell ls --device macmini  # one device/profile only (stable JSON shape)',
    'devbox shell macmini --device macmini  # attach by name on a specific device',
    'devbox shell rm agents   # close one session (looked up across devices when no --device is given)',
    'devbox shell rm --unattached --all-devices  # close detached sessions on every device',
    'devbox shell rm this     # from inside a devbox shell, on any hub; needs no profile'
  ]
  }
