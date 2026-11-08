import type { CommandSpec } from './args'
import { HUB_COMMAND_SPECS } from './specs-hub'
import { SHELL_COMMAND_SPEC } from './specs-shell'
import { DEVICE_COMMAND_SPECS } from './specs-device'
import { SYNC_COMMAND_SPEC } from './specs-sync'

const COMMON = ['profile', 'device', 'operation-key']
const JSON = ['profile', 'device', 'operation-key']

export const COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pair'],
    summary: 'Pair and start a Devbox profile',
    usage: 'devbox pair [--profile <id>] [--json]',
    allowedFlags: [...COMMON, 'force', 'yes', 'confirm'],
    notes: ['Force takeover requires --confirm "TAKE OVER <profile>" and is unavailable.']
  },
  {
    path: ['status'],
    summary: 'Show a Devbox profile status',
    usage: 'devbox status [--profile <id>] [--json]',
    allowedFlags: JSON
  },
  {
    path: ['disable'],
    summary: 'Stop synchronization for a Devbox profile',
    usage: 'devbox disable [--profile <id>] [--json]',
    allowedFlags: JSON
  },
  SYNC_COMMAND_SPEC,
  ...HUB_COMMAND_SPECS,
  SHELL_COMMAND_SPEC,
  {
    path: ['phi'],
    summary: 'Launch Phi through the Devbox host',
    usage: 'devbox phi [--profile <id>] --path <local-path> --session-id <id> --relay-epoch <epoch>',
    allowedFlags: [...COMMON, 'path', 'session-id', 'relay-epoch']
  },
  {
    path: ['run'],
    summary: 'Run a detached command in a verified Devbox generation',
    usage: 'devbox run [--profile <id>] [--id <job-id>] [--cwd <path>] [--consistent] [--attach] -- [argv...]',
    allowedFlags: [...COMMON, 'id', 'cwd', 'env', 'command', 'consistent', 'attach']
  },
  {
    path: ['git'],
    argumentMode: 'passthrough',
    summary: 'Run git argv through the Devbox stateful authority',
    usage: 'devbox git [--profile <id>] --path <local-path> -- [git argv...]',
    allowedFlags: [...COMMON, 'path']
  },
  {
    path: ['jobs', 'status'],
    summary: 'Show a detached Devbox job',
    usage: 'devbox jobs status [--profile <id>] --job-id <id> [--json]',
    allowedFlags: [...COMMON, 'job-id']
  },
  {
    path: ['jobs', 'cancel'],
    summary: 'Cancel a detached Devbox job',
    usage: 'devbox jobs cancel [--profile <id>] --job-id <id> [--json]',
    allowedFlags: [...COMMON, 'job-id']
  },
  {
    path: ['jobs', 'log'],
    summary: 'Read a bounded Devbox job log tail',
    usage: 'devbox jobs log [--profile <id>] --job-id <id> [--offset <n>] [--limit <n>]',
    allowedFlags: [...COMMON, 'job-id', 'offset', 'limit']
  },
  {
    path: ['ports', 'open'],
    summary: 'Open a port through the Devbox SSH authority',
    usage: 'devbox ports open [--profile <id>] --remote-port <port> [--public] [--label <text>] (foreground; Ctrl-C closes)',
    allowedFlags: [...COMMON, 'remote-port', 'public', 'label']
  },
  ...DEVICE_COMMAND_SPECS,
  {
    path: ['profile', 'list'],
    summary: 'List saved Devbox profiles and the default',
    usage: 'devbox profile list [--json]',
    allowedFlags: []
  },
  {
    path: ['profile', 'use'],
    summary: 'Set or clear the default Devbox profile',
    usage: 'devbox profile use <id> | --clear',
    allowedFlags: ['clear']
  },
  {
    path: ['profile', 'env-file'],
    summary: 'Clear the local credential env-file preference',
    usage: 'devbox profile env-file --clear [--profile <id>|--device <name>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'env-file', 'set'],
    summary: 'Set the local credential env-file path for a profile',
    usage: 'devbox profile env-file set <path> [--profile <id>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'env-file', 'show'],
    summary: 'Show the configured local credential env-file path',
    usage: 'devbox profile env-file show [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'shell-dir'],
    summary: 'Clear the default remote shell directory',
    usage: 'devbox profile shell-dir --clear [--profile <id>|--device <name>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'shell-dir', 'set'],
    summary: 'Set the default remote directory for new shells',
    usage: 'devbox profile shell-dir set <remote-dir> [--profile <id>|--device <name>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'shell-dir', 'show'],
    summary: 'Show the default remote directory for new shells',
    usage: 'devbox profile shell-dir show [--profile <id>|--device <name>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'device'],
    summary: 'Clear the human-facing device alias for a profile',
    usage: 'devbox profile device --clear [--profile <id>|--device <name>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'device', 'set'],
    summary: 'Set the human-facing device alias for a profile',
    usage: 'devbox profile device set <alias> [--profile <id>|--device <name>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'device', 'show'],
    summary: 'Show the human-facing device alias for a profile',
    usage: 'devbox profile device show [--profile <id>|--device <name>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'sync-max-entry-count'],
    summary: 'Reset the profile Mutagen entry cap to the supported default',
    usage: 'devbox profile sync-max-entry-count --clear [--profile <id>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'sync-max-entry-count', 'set'],
    summary: 'Set the profile Mutagen entry cap for new sessions',
    usage: 'devbox profile sync-max-entry-count set <count> [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'sync-max-entry-count', 'show'],
    summary: 'Show the profile Mutagen entry cap',
    usage: 'devbox profile sync-max-entry-count show [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'sync-watch-polling-interval'],
    summary: 'Clear the profile Mutagen watch polling override to the 10-second default',
    usage: 'devbox profile sync-watch-polling-interval --clear [--profile <id>] [--json]',
    allowedFlags: [...COMMON, 'clear']
  },
  {
    path: ['profile', 'sync-watch-polling-interval', 'set'],
    summary: 'Set the profile Mutagen watch polling interval for new sessions',
    usage: 'devbox profile sync-watch-polling-interval set <seconds> [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'sync-watch-polling-interval', 'show'],
    summary: 'Show the profile Mutagen watch polling interval override',
    usage: 'devbox profile sync-watch-polling-interval show [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'ignore', 'add'],
    summary: 'Add persisted profile ignore patterns',
    usage: 'devbox profile ignore add <pattern...> [--root-class <class>] [--profile <id>] [--json]',
    allowedFlags: [...COMMON, 'root-class']
  },
  {
    path: ['profile', 'ignore', 'list'],
    summary: 'List persisted Git-roaming ignore patterns',
    usage: 'devbox profile ignore list [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'ignore', 'rm'],
    summary: 'Remove persisted Git-roaming ignore patterns',
    usage: 'devbox profile ignore rm <pattern...> [--profile <id>] [--json]',
    allowedFlags: COMMON
  },
  {
    path: ['profile', 'credentials', 'enable'],
    summary: 'Enable opt-in MCP credential roaming for a profile',
    usage: 'devbox profile credentials enable [--profile <id>] [--local-root <abs>] [--remote-root <abs>] [--exclude <pattern>]... [--json]',
    allowedFlags: [...COMMON, 'local-root', 'remote-root', 'exclude']
  },
  {
    path: ['profile', 'credentials', 'disable'],
    summary: 'Disable MCP credential roaming for a profile',
    usage: 'devbox profile credentials disable [--profile <id>] [--json]',
    allowedFlags: JSON
  },
  {
    path: ['profile', 'credentials', 'show'],
    summary: 'Show MCP credential roaming for a profile',
    usage: 'devbox profile credentials show [--profile <id>] [--json]',
    allowedFlags: JSON
  },
  {
    path: ['profile', 'paste', 'enable'],
    summary: 'Mirror clipboard-paste images (terminal-paste-*) to the same path on the remote',
    usage: 'devbox profile paste enable [--profile <id>] [--local-root <abs>] [--remote-root <abs>] [--pattern <glob>]... [--skip-remote-prepare] [--json]',
    allowedFlags: [...COMMON, 'local-root', 'remote-root', 'pattern', 'skip-remote-prepare'],
    notes: [
      'Defaults: --local-root is this machine\'s temp dir ($TMPDIR), --remote-root mirrors the same absolute path.',
      'Only root-level files matching the patterns are synced, one-way, laptop -> remote.'
    ]
  },
  {
    path: ['profile', 'paste', 'disable'],
    summary: 'Stop mirroring clipboard-paste images for a profile',
    usage: 'devbox profile paste disable [--profile <id>] [--json]',
    allowedFlags: JSON
  },
  {
    path: ['profile', 'paste', 'show'],
    summary: 'Show clipboard-paste mirroring for a profile',
    usage: 'devbox profile paste show [--profile <id>] [--json]',
    allowedFlags: JSON
  },
  {
    path: ['profile', 'create'],
    summary: 'Enroll a pinned SSH Devbox profile',
    usage:
      'devbox profile create --profile <id> --host <h> --user <u> --local-root <abs> --remote-root <abs> [--proxy-command <cmd>] [--git-roaming] [--ignore <pattern>] [--yes]',
    allowedFlags: [
      'profile',
      'host',
      'port',
      'user',
      'local-root',
      'remote-root',
      'fingerprint',
      'proxy-command',
      'yes',
      'force',
      'git-roaming',
      'dry-run',
      'ignore'
    ]
  },
  {
    path: ['preflight'],
    summary: 'Run read-only checks for a Devbox profile',
    usage: 'devbox preflight [--profile <id>] [--json]',
    allowedFlags: ['profile']
  },
  ...blockedSpec('doctor', 'Diagnose a Devbox profile'),
  ...blockedSpec('repair', 'Repair a Devbox profile'),
  {
    path: ['handoff'],
    summary: 'Hand off whole-profile Git authority',
    usage: 'devbox handoff [--profile <id>] --to local|remote [--json]',
    allowedFlags: [...JSON, 'to'],
    notes: ['Phase 1 uses cooperative whole-profile fencing; --force is unavailable.']
  },
  ...blockedSpec('conflicts', 'List Devbox synchronization conflicts'),
  ...blockedSpec('support', 'Create a Devbox support bundle')
]

function blockedSpec(command: string, summary: string): CommandSpec[] {
  return [
    {
      path: [command],
      summary,
      usage: `devbox ${command} [--profile <id>] [--json]`,
      allowedFlags: [...COMMON, 'force', 'yes', 'confirm'],
      notes: ['BLOCKED: T-006 has no runtime operation for this command.']
    }
  ]
}

export const DEVBOX_COMMAND_SPECS = COMMAND_SPECS
