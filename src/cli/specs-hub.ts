import type { CommandSpec } from './args'

const HUB_COMMON = ['profile', 'device', 'operation-key']

export const HUB_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['init'],
    summary: 'Set up a whole Devbox workspace: this machine seeds a new hub on the remote',
    usage: 'devbox init --host <h> --user <u> --local-root <abs> [--remote-root <abs>] [--profile <id>] [--port <n>] [--fingerprint <sha256>|--yes] [--proxy-command <cmd>] [--env-file <path>] [--shell-dir <remote-dir>] [--adopt-remote] [--no-service] [--no-pair] [--force] [--json]',
    allowedFlags: ['host', 'user', 'port', 'profile', 'device', 'local-root', 'remote-root', 'fingerprint', 'proxy-command', 'yes', 'force', 'env-file', 'shell-dir', 'adopt-remote', 'no-service', 'no-pair', 'operation-key'],
    notes: [
      'Hub and spoke: the remote host + remote root becomes the hub (source of truth); this machine is a spoke. Spokes only ever sync with the hub, never with each other.',
      'Defaults: --profile = the basename of --local-root sanitized to [A-Za-z0-9._-] (other characters become -, capped at 64 characters, must start alphanumeric, fallback devbox); --remote-root = <remote $HOME>/<basename>. The remote root must be empty or missing unless --adopt-remote is passed (two-way-safe: differing files become conflicts, never deletions).',
      'Runs: local-root, host-key, profile, remote, preflight, default-profile, env-file, shell-dir, service, pair, hub-registry. Re-running on an existing profile requires --force.',
      '--proxy-command pins an OpenSSH ProxyCommand into the profile (proxy-powered hostes: "$HOME/.local/bin/devbox proxy"); --host stays the stable alias used as the known_hosts token, and host keys are read through the proxy. Mutagen and rsync use your own ssh config, so the alias also needs its Host block in ~/.ssh/config.'
    ],
    examples: [
      'devbox init --host 203.0.113.10 --user sample --local-root ~/project --yes',
      'devbox init --host devbox.example.com --user sample --local-root ~/work --remote-root /home/sample/work --fingerprint <SHA256:fingerprint> --env-file ~/.config/devbox/secrets.env',
      'devbox init --host devbox --user <user> --port 22 --proxy-command "$HOME/.local/bin/devbox proxy" --local-root ~/project --remote-root /home/<user>/project --fingerprint <SHA256:fingerprint>'
    ]
  },
  {
    path: ['connect'],
    summary: 'Join an existing Devbox hub from this machine as another spoke',
    usage: 'devbox connect --host <h> --user <u> --remote-root <abs> [--local-root <abs>] [--profile <id>] [--port <n>] [--fingerprint <sha256>|--yes] [--proxy-command <cmd>] [--env-file <path>] [--shell-dir <remote-dir>] [--allow-non-empty-local] [--no-service] [--no-pair] [--force] [--json]',
    allowedFlags: ['host', 'user', 'port', 'profile', 'device', 'local-root', 'remote-root', 'fingerprint', 'proxy-command', 'yes', 'force', 'env-file', 'shell-dir', 'allow-non-empty-local', 'no-service', 'no-pair', 'operation-key'],
    notes: [
      'The hub (remote root) must already exist; the first sync pulls it into the local root. Defaults: --profile = the basename of --remote-root sanitized to [A-Za-z0-9._-] (other characters become -, capped at 64 characters, must start alphanumeric, fallback devbox); --local-root = ~/<basename>.',
      'The local root must be empty or missing unless --allow-non-empty-local is passed. A hub that resolves to this machine is refused: Devbox never syncs local ↔ local.'
    ],
    examples: ['devbox connect --host 203.0.113.10 --user sample --remote-root /home/sample/project --yes']
  },
  {
    path: ['mutagen', 'status'],
    summary: 'Show the Mutagen daemon, keepalive service, sessions, topology, and hub registry',
    usage: 'devbox mutagen status [--profile <id>] [--no-remote] [--json]',
    allowedFlags: [...HUB_COMMON, 'no-remote'],
    notes: ['Works without a profile: it reports binary, service, daemon, sessions (all Devbox-owned), topology, and hints, with hub: null. --no-remote skips the SSH hub-registry lookup.']
  },
  {
    path: ['mutagen', 'setup'],
    summary: 'Install the keepalive service for the app-private Mutagen daemon and optionally register this spoke on the hub',
    usage: 'devbox mutagen setup [--profile <id>] [--no-service] [--no-remote] [--json]',
    allowedFlags: [...HUB_COMMON, 'no-service', 'no-remote'],
    notes: ['macOS: LaunchAgent org.devbox.mutagen-daemon; Linux: systemd --user unit devbox-mutagen-daemon.service. Idempotent; safe to re-run after upgrades. Registers the spoke only when a profile is selected and --no-remote is not passed. Supersedes the hand-rolled LaunchAgent from docs/devbox-recovery.md.']
  },
  ...(['start', 'stop', 'restart'] as const).map((verb): CommandSpec => ({
    path: ['mutagen', verb],
    summary: `${verb[0]!.toUpperCase()}${verb.slice(1)} the Mutagen daemon (through the keepalive service when installed)`,
    usage: `devbox mutagen ${verb} [--json]`,
    allowedFlags: ['operation-key'],
    ...(verb === 'stop' ? { notes: ['Stops the supervised daemon and any on-demand daemon; sessions resume when the daemon returns. Use devbox disable to terminate sessions.'] } : {})
  })),
  {
    path: ['mutagen', 'delete'],
    summary: 'Remove the keepalive service (sessions are untouched)',
    usage: 'devbox mutagen delete [--json]',
    allowedFlags: ['operation-key'],
    notes: ['Removes the LaunchAgent / systemd unit and the wrapper script. Sessions and the Mutagen data directory stay; sync-touching commands (status, sync, pair) start the daemon on demand; `devbox mutagen status` never does.']
  },
  {
    path: ['mutagen', 'uninstall'],
    summary: 'Alias of devbox mutagen delete',
    usage: 'devbox mutagen uninstall [--json]',
    allowedFlags: ['operation-key']
  },
  {
    path: ['mutagen', 'logs'],
    summary: 'Tail the keepalive service log',
    usage: 'devbox mutagen logs [--lines <n>] [--json]',
    allowedFlags: ['operation-key', 'lines'],
    notes: ['The default is 80 lines; --lines must be a positive integer.']
  },
  {
    path: ['mutagen', 'pause'],
    summary: 'Pause every Devbox-owned Mutagen session of a profile',
    usage: 'devbox mutagen pause [--profile <id>] [--json]',
    allowedFlags: [...HUB_COMMON]
  },
  ...(['flush', 'resume'] as const).map((verb): CommandSpec => ({
    path: ['mutagen', verb],
    summary: 'Sync a profile once now (same as devbox sync --profile <id>)',
    usage: `devbox mutagen ${verb} [--profile <id>] [--wake] [--timeout <seconds>] [--plain] [--json]`,
    allowedFlags: [...HUB_COMMON, 'wake', 'timeout', 'plain'],
    notes: ['Devbox never leaves a Mutagen session running: this resumes the profile\'s sessions, flushes them, and pauses them again, exactly like `devbox sync --profile <id>`. There is no continuous sync.']
  })),
  {
    path: ['mutagen', 'spokes'],
    summary: "List the spokes registered on the profile's hub",
    usage: 'devbox mutagen spokes [--profile <id>] [--json]',
    allowedFlags: [...HUB_COMMON]
  },
  {
    path: ['profile', 'proxy-command', 'set'],
    summary: 'Route every Devbox ssh connection for a profile through an OpenSSH ProxyCommand',
    usage: 'devbox profile proxy-command set "<command>" --profile <id> [--json]',
    allowedFlags: HUB_COMMON,
    notes: ['Quote the command as one argument. OpenSSH expands %h/%p/%r tokens; write a literal % as %%. The host-key pin is unchanged.'],
    examples: ['devbox profile proxy-command set "$HOME/.local/bin/devbox proxy" --profile devbox']
  },
  {
    path: ['profile', 'proxy-command', 'clear'],
    summary: 'Remove the profile ProxyCommand (connect directly to the host again)',
    usage: 'devbox profile proxy-command clear --profile <id> [--json]',
    allowedFlags: HUB_COMMON
  },
  {
    path: ['profile', 'proxy-command', 'show'],
    summary: 'Show the profile ProxyCommand',
    usage: 'devbox profile proxy-command show --profile <id> [--json]',
    allowedFlags: HUB_COMMON
  }
]
