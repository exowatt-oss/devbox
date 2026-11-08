import type { CommandSpec } from './args'

/** `devbox sync` (sync now): every Devbox-owned Mutagen session, every machine, one live view. */
export const SYNC_COMMAND_SPEC: CommandSpec = {
  path: ['sync'],
  summary: 'Sync every machine now (live view; skips unreachable or hung machines)',
  usage: 'devbox sync [--profile <id>] [--device <alias>] [--wake] [--timeout <seconds>] [--plain] [--json]',
  allowedFlags: ['profile', 'device', 'wake', 'timeout', 'plain', 'operation-key'],
  notes: [
    'Flushes every Devbox-owned Mutagen session (workspace, paste images, credentials, phi sessions) to every machine in parallel; no flags = all machines, --profile/--device narrow it.',
    'A machine that does not answer its ssh probe is skipped (unreachable); an optionally configured power provider can identify a stopped host; --wake allows probing it; an endpoint disconnected for 30 s mid-sync is skipped (stalled); --timeout caps each machine (default 900 s, 0 = none).',
    'Sessions are resumed only after their machine answered. Every session of the run ends paused on every exit path, Ctrl-C included (a second Ctrl-C exits at once), including any it found running: Devbox never leaves a session live-syncing.',
    'Hooks: an executable <state root>/hooks/sync/<profile> runs as `<hook> before` and `<hook> after`; failures become warnings.',
    'Exit 0 when nothing failed (skips are expected), 1 when a machine failed, 130 when interrupted. One run at a time: a second run, `mutagen stop`, and `mutagen restart` wait for the lock.'
  ],
  examples: [
    'db sync                    # every machine, live view',
    'db sync --device macmini   # one machine',
    'db sync --wake             # allow probing a stopped host with a configured power provider',
    'db sync --plain --timeout 600   # line log for cron/launchd'
  ]
}
