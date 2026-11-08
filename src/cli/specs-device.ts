import type { CommandSpec } from './args'

const DEVICE_DEFAULT_NOTE =
  'The default device is the default profile: `device --default <alias>` is `profile use <id>` addressed by device alias (a profile id is accepted too). DEVBOX_PROFILE and --profile/--device still override it per command.'

/** `devbox device` help surface: everyday device-alias view of profiles and the default selection. */
export const DEVICE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['device'],
    summary: 'List devices, or set/show/clear the default device',
    usage: 'devbox device [ls] | --default [<alias-or-profile-id>] | --clear-default [--json]',
    allowedFlags: ['default', 'clear-default'],
    notes: [DEVICE_DEFAULT_NOTE],
    examples: [
      'devbox device                 # list devices; * marks the default',
      'devbox device --default remote   # shell/run/mutagen now default to remote',
      'devbox shell new agents       # opens on remote, no --device flag',
      'devbox device --default       # show the current default device',
      'devbox device --clear-default # no default device'
    ]
  },
  {
    path: ['device', 'ls'],
    summary: 'List devices (alias, profile id, user@host); * marks the default',
    usage: 'devbox device ls [--json]',
    allowedFlags: []
  },
  {
    path: ['device', 'default'],
    summary: 'Show the current default device',
    usage: 'devbox device default [--json]',
    allowedFlags: [],
    notes: [DEVICE_DEFAULT_NOTE]
  }
]
