# Devbox operator reference

A Devbox profile makes one trusted SSH host the execution host for a workspace while the
standalone Devbox CLI/runtime remains the control surface. Terminals, optional phi integration, agents,
detached jobs, ports, and browser/OAuth forwarding stay within the standalone Devbox
boundary. The profile describes the host, the workspace mapping, the sync policy, and
references to credential capabilities. It does not contain secret values.

This page documents the checked-in Devbox runtime and CLI surface. The plan describes
additional future operator surfaces. A command is not available merely because its
name appears in the plan: the blocked commands and their current limitations are listed
below.

## Zero-environment contract

Installing the Devbox binary is the opt-in. The standalone CLI operates with zero
required environment variables; profile, sync, job, SSH, and shell commands are
available immediately after installation. It uses the default state locations below
and resolves its verified Mutagen dependency automatically.

## State: local state, remote state, and installation

The standalone CLI keeps its local state under `${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}`; set
`DEVBOX_STATE_ROOT` to relocate it. Under the default root, the root contains these
app-owned paths:

- `~/.local/state/devbox/profiles/` — validated profiles, journals, and profile-local durable state;
- `~/.local/state/devbox/generations/` — isolated workspace generations and recovery checkpoints;
- `~/.local/state/devbox/mutagen/` — the app-private Mutagen data directory;
- `~/.local/state/devbox/bin/devbox-mutagen-daemon` — the generated keepalive wrapper;
- `~/.local/state/devbox/logs/mutagen-daemon.log` — the keepalive service log;
- `~/.local/state/devbox/spoke.json` — this machine's spoke identity; and
- `~/.local/state/devbox/spoke-roots.json` — local roots enrolled as spokes (the no-chaining guard reads it).

On macOS the service unit is `~/Library/LaunchAgents/org.devbox.mutagen-daemon.plist`;
on Linux it is `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/devbox-mutagen-daemon.service`
(`XDG_CONFIG_HOME` is honored). The former uses RunAtLoad + KeepAlive; the latter uses
Restart=always and requires a logged-in user manager or `loginctl enable-linger`.

The remote user's job/witness root is `$HOME/.local/state/devbox/<profile>`. Hub registry records
are under `$HOME/.local/state/devbox/hub/<hubId>/hub.json` and
`$HOME/.local/state/devbox/hub/<hubId>/spokes/<spokeId>.json`, where `hubId` is the first
12 hex characters of sha256(remote root path). The remote hosts no Devbox service or
Mutagen daemon; Mutagen installs its SSH agent under `~/.mutagen/agents/0.18.1/` as
needed. Do not replace these paths with a global or unrelated Mutagen namespace.
Mutagen v0.18.1 is an external, managed binary and is not bundled in Devbox; supply its
approved absolute path through `DEVBOX_MUTAGEN_BINARY` and keep its data directory under
the app-private `${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen` path.


Download and inspect the public installer from the [latest release](https://github.com/exowatt-oss/devbox/releases/latest), then run `sh ./devbox-install.sh`. No account or token is required. See [INSTALL.md](INSTALL.md) for source builds and upgrades.

## What a profile contains

The current profile schema is `DevboxProfileV1` (schema version `1`). A valid profile
contains:

- an opaque profile `id` and display name;
- an SSH target ID and exact identity: host, port, username, and host-key fingerprint;
- a local root and remote root, plus explicit local-to-remote path-map entries;
- optionally, an absolute remote shell directory for newly created terminals;
- optionally, an absolute local credential env-file path (the file contents are never in the profile);
- an immutable toolchain-lock reference and SHA-256 digest;
- sync classes and exclusions;
- value-free credential declarations;
- the default stateful authority, `local` or `remote`;
- defaults for remote terminals, agents, automations, detached jobs, and closed-session
  history; and
- sync-lag, reconnect, operation-recovery, and offline-edit policy values.

Profile persistence is validated and normalized. A malformed profile or a profile with a
newer schema disables Devbox without changing ordinary Devbox behavior. Secret-bearing
fields such as `secret`, `token`, `password`, and `private` are rejected from the
profile. Keep credentials in the credential plane described below.

## Profile creation, preflight, pairing, and adoption

Create a profile only for roots whose contents you have reviewed. The CLI requires
absolute roots, scans the SSH endpoint, writes a private `known_hosts` file, and stores
the selected SHA-256 host-key fingerprint in the profile. Pin a reviewed fingerprint
rather than accepting the first scan result by default:

```bash
ssh-keyscan -T 10 -p 22 <ssh-host> > /tmp/devbox-known-hosts
ssh-keygen -lf /tmp/devbox-known-hosts -E sha256

devbox profile create --profile <profile-id> \
  --host <ssh-host> --port 22 --user <user> \
  --local-root "$HOME/src/project" \
  --remote-root /home/<user>/project \
  --fingerprint SHA256:<reviewed-host-key> --yes
rm -f /tmp/devbox-known-hosts
```

`--fingerprint` must match one of the keys returned by `ssh-keyscan`. `--yes` accepts the
scan without an interactive prompt; omitting `--fingerprint` with `--yes` selects the
first scanned fingerprint. Profile creation does not transfer workspace data. For a Git-roaming profile, use the
explicit read-only adoption gate before pairing:

```bash
devbox profile create --profile project-roam \
  --host <ssh-host> --port 22 --user <user> \
  --local-root /Users/<user>/project --remote-root /home/<user>/project \
  --fingerprint SHA256:<reviewed-host-key> --git-roaming \
  --ignore '**/.venv/' --ignore '**/node_modules/' --yes

devbox profile create --profile project-roam --host <ssh-host> --user <user> \
  --local-root /Users/<user>/project --remote-root /home/<user>/project \
  --fingerprint SHA256:<reviewed-host-key> --git-roaming --dry-run --json
```

`--git-roaming --dry-run` inventories both real clone sets without writing a profile,
known-hosts file, marker, or workspace byte. A roaming profile is working-tree-only:
`.git` and `.git.devbox-parked` remain private and excluded from Mutagen. Pairing does
not require a clean tree, a published HEAD, or a worktree-free clone: those findings
are named informational warnings at pair time and strict refusal conditions at handoff.
Genuine pair-time hazards (missing roots/repositories, topology/path-safety hard
collisions, or an inability to park/unpark metadata) still block. Ordinary non-roaming
profiles still require empty roots for adoption.

Pair-time and handoff-time are deliberately different contracts:

| Finding | Pair | Handoff |
| --- | --- | --- |
| Dirty or unpublished repository | Informational warning, pair continues | Refuse with repository evidence |
| Origin-less repository or passive `git fetch` failure | Named warning with git stderr, pair continues | Refuse; published origin is required |
| Linked worktree, active operation, or excluded tracked path | Informational warning where inventory can continue | Refuse |
| Missing remote root/repository, hard in-scope path collision, park/unpark failure | Block | Block |

Pair warnings are present in the `pair` result envelope and `devbox status --json`.
They are not an offline classification: fetch failures include the repository and the
actual Git stderr.

`devbox preflight` is a read-only check of the exact endpoint and pinned host key,
platform, prerequisites, capacity, and path safety. It must report `status: ready` and
no blockers before pairing:

```bash
devbox preflight [--profile <profile-id>] [--json]
```

Path safety has three outcomes. A hard case/Unicode collision or path-type conflict
inside the sync scope is `block`. An out-of-root symlink, unsupported filesystem
entry, or collision entirely below an ignored path is `warn`; the issue carries its
category and both candidate paths. A successful inventory with no findings is `pass`.
Use `--json` to obtain the complete `pathIssues` listing and the blocking/warning
counts; the human output reports the same status without treating warnings as
blockers.

Persist profile ignores instead of editing profile JSON by hand. This works for plain and
Git-roaming profiles:

```bash
devbox profile ignore add '**/.venv/' --root-class portable-working --profile <profile-id>
devbox profile ignore list --profile <profile-id>
devbox profile ignore rm '**/.venv/' --profile <profile-id>
devbox profile ignore add '/.data/' --profile <profile-id>   # only the top-level .data
```

Patterns use Mutagen's ignore syntax. A pattern with no `/` except a trailing one
(`.data/`) matches that name at any depth; one leading `/` anchors it to the sync root
(`/.data/` matches only `<root>/.data`), which rsync's filter rules read the same way.

Profile creation also accepts repeatable `--ignore <pattern>` flags. `sync.excludes` is
the canonical exclude store for every profile; legacy `gitRoaming.ignorePatterns` is
read and mirrored so older roaming records remain usable. Rules are schema-versioned
with the profile. The `root-class` is retained as compatibility metadata, while canonical
`sync.excludes` is applied to all newly created portable sessions. An existing paired session
does not hot-reload profile policy: the command reports this explicitly, and the profile
must be re-paired before the change is active; no live refresh command is exposed.

Mutagen's scan ceiling is profile-configurable and defaults to 2,000,000 entries:

```bash
devbox profile sync-max-entry-count show --profile <profile-id>
devbox profile sync-max-entry-count set 2000000 --profile <profile-id>
devbox profile sync-max-entry-count --clear --profile <profile-id>
```

The value is stored at `sync.maxEntryCount` and is passed to Mutagen only when a new
session is created. Changing it never re-pairs, disables, terminates, or refreshes a
current session. The default is intentionally high enough for large workspaces; an
operator can set a smaller value for a throwaway profile to make scan failures visible.

Devbox passes **no** `--max-staging-file-size` when it creates a session, so Mutagen's own
unlimited default applies. Mutagen does not skip a file that exceeds that cap: it streams
the file, aborts the staging write at the limit, fails the transition with `no such file or
directory`, and retries the full transfer on every cycle. Sessions created by Devbox
`<= 0.2.16` carried a 100 MB cap and looped like this on every large artifact (an
`~/project`-sized workspace re-sent ~15 GB per cycle and every cycle took minutes); disable
and pair again to recreate them. Keep large build or data artifacts out of a sync root with
ignore patterns instead of a size cap.

Mutagen watch detection cadence is also an optional profile preference:

```bash
devbox profile sync-watch-polling-interval show --profile <profile-id>
devbox profile sync-watch-polling-interval set 60 --profile <profile-id>
devbox profile sync-watch-polling-interval --clear --profile <profile-id>
```

The value is stored at `sync.watchPollingIntervalSeconds`. When it is absent, Devbox
continues to use the unchanged global `10`-second Mutagen default; `60` means Mutagen
receives `--watch-polling-interval=60` when a new session is created. This setting changes
only watch detection cadence: the full configured `~/project` two-way-safe tree remains
synced with the existing exclusion policy, and the `sync.maxEntryCount` behavior remains
2,000,000 by default. It does not add ignores or reduce the sync scope. Existing sessions
are not silently adopted when their effective interval differs or Mutagen does not expose
an interval to verify; disable the profile and pair it again to recreate those sessions.

Pairing means loading a saved profile into the running Devbox runtime. `devbox pair`
starts the profile, replays its operation journal, creates or restores the app-owned
sync supervisor, and returns status. Sessions are created **paused**: Devbox never runs a
continuous (watching) sync. Files move only when `db sync` runs (on demand, or from a
scheduled job such as a 10-minute launchd timer), which resumes, flushes, and pauses
every session again. It is not a second SSH client: the CLI calls
Devbox's runtime bridge, and the runtime owns the SSH and sync work.

With a configured default (or exactly one saved profile), pairing is bare:

```bash
devbox pair
```
Use `--profile <profile-id>` when selecting a different profile.

`--json` produces the machine-readable status envelope. `--operation-key <value>` can
supply a stable explicit operation key. `--force`, `--yes`, and `--confirm <text>` are
parsed for pairing, but force takeover is deliberately not implemented by the frozen
IPC. The exact typed phrase is required before the handler reports that limitation; it
never performs a takeover:

```bash
devbox pair --profile <profile-id> \
  --force --confirm "TAKE OVER <profile-id>"
```

Do not use that command as a recovery action. It fails closed with “Force takeover is
unavailable in the frozen T-006 IPC”. `--yes` never replaces the typed confirmation.

## Sync and its safety model

The profile separates state classes instead of treating the home directory as one
replica:

| Class                      | Current policy                                           |
| -------------------------- | -------------------------------------------------------- |
| Portable working files     | Mutagen `two-way-safe`, or degraded directional fallback |
| Portable declarative files | Mutagen `two-way-safe`, or degraded directional fallback |
| Git durable state          | rsync fallback, checkpoint-only                          |
| Session durable state      | rsync fallback, authority-only                           |
| Generated state            | rsync fallback, rebuild-on-host                          |
| Credentials                | Mutagen (opt-in), two-way-resolved, allow-listed roots  |
| Clipboard pastes           | Mutagen (opt-in), one-way-replica, pattern-filtered root |
| Stateful services          | rsync fallback, host-local                               |
| Unsupported data           | rsync fallback, excluded                                 |

Only `portable-working` and `portable-declarative` classes are turned into Mutagen sync
requests, and only a class that the profile's `pathMap` (or `sync.defaultClassId`) routes
to gets a session. Every portable session spans the whole root pair, so the
`portable-declarative` class that `profile create` writes, which no path-map entry uses,
gets no session; profiles paired before 0.6.5 have a duplicate `portable-declarative`
session over the same roots that `devbox disable --profile <id> && devbox pair --profile
<id>` removes. `.git`, active coding-agent sessions (including optional phi sessions), credentials, OAuth state, databases,
sockets, package stores, virtual environments, and generated/build outputs remain
excluded from the generic working-file channel. Credential roaming is an explicit opt-in
exception: `~/.mcp-auth` may be an MCP OAuth token cache shared by optional phi MCP OAuth
and `mcp-remote`, so one allow-listed root covers several MCP OAuth servers (for
example Slack and Google). Credential roots use `two-way-resolved` with alpha (the laptop) as the winner;
this matches Slack's rotating refresh tokens. A rare double-refresh can still require
one re-login. Transient files `*_code_verifier*.txt`, `*_lock*.json`, `*_debug*.log`, and
`*.stale-*` (plus `.DS_Store`) are excluded. For an allow-listed credential root only,
the base secret-name exclusions are bypassed; the root's explicit exclusions still
apply. Excludes are captured at session creation. After changing them (or upgrading
devbox with new defaults), run `devbox profile credentials enable --profile <id>` and
then `devbox disable --profile <id> && devbox pair --profile <id>` to recreate the
session. Credential roaming is disabled until enabled for a profile:

```bash
devbox profile credentials enable  [--profile <id>] \
  [--local-root <abs>] [--remote-root <abs>] [--exclude <pattern>]... [--json]
devbox profile credentials disable [--profile <id>] [--json]
devbox profile credentials show    [--profile <id>] [--json]
```

Enable defaults to the local `~/.mcp-auth` and the remote `$HOME/.mcp-auth`; use the
root flags when those paths differ. Path-name detection is not a promise that an
embedded secret in an ordinary-looking source file will be found.

#### Clipboard-paste mirroring (`devbox profile paste`)

A terminal host saves an image pasted into a terminal as
`<temp>/terminal-paste-<ts>-<uuid>.png` on the **control machine** and pastes that absolute
path. In a remote terminal the agent runs on the devbox host, where the path does not
exist (a platform-specific local temporary directory may be absent on the remote). Paste mirroring makes the path available: an
opt-in `pasteSync` root creates a `one-way-replica` Mutagen session from the laptop temp
directory to the **same absolute path** on the remote, ignoring `*` and un-ignoring only
the paste patterns (`terminal-paste-*` by default). Only root-level matches
sync; subdirectories are never scanned. Deletions follow the laptop (macOS temp cleanup
empties the mirror), and nothing on the remote is ever copied back.

```bash
devbox profile paste enable  [--profile <id>] \
  [--local-root <abs>] [--remote-root <abs>] [--pattern <glob>]... [--skip-remote-prepare] [--json]
devbox profile paste disable [--profile <id>] [--json]
devbox profile paste show    [--profile <id>] [--json]
```

`--local-root` defaults to this machine's temp directory (`$TMPDIR`, trailing slash
trimmed) and `--remote-root` to the same path. Enable also runs a best-effort
`mkdir -p` + writability check over SSH: when the mirrored path is outside the remote
user's home (the macOS case) the result carries a copy-paste `sudo mkdir -p ... && sudo
chown -R <user> ...` line for the remote. Then `devbox pair --profile <id>` (or
`devbox disable && devbox pair` when a root already existed) creates the session (paused,
like every Devbox session), and `read <pasted path>` on the remote works after the next
`db sync`. Patterns are plain root-level file globs: no separators,
no `..`, no leading `!`.

### Mutagen daemon service and hub registry

For `db init`, the default profile ID is the basename of `--local-root`; for `db connect`,
it is the basename of `--remote-root`. Both are sanitized to `[A-Za-z0-9._-]` (other
characters become `-`), capped at 64 characters, required to start alphanumeric, and
fall back to `devbox` otherwise.

Devbox owns one app-private Mutagen daemon per spoke. The hub is only the remote Linux
host and remote root: it runs no daemon, only the `mutagen-agent` processes spawned over
SSH by each spoke. A workspace has one hub and N spokes; every owned session must have
`alpha = local root` and `beta = ssh://<hub user>@<hub host>/<hub root>`. Spokes never
sync with one another. For both `db init` and `db connect`, a local hub (`hub-is-local`)
is refused before any bootstrap step with an error envelope code
`operation_conflict` and exit `6`. A remote root recorded as a spoke root
(`hub-root-is-a-spoke`) is refused in the `remote` step for both commands; the result
status is `failed`, exit `1`, and the later `hub-registry` warning path is not reached.
`status` reports any session that breaks this shape as a topology violation.

```text
laptop A (spoke)  <──────>  HUB: remote Linux + remote root  <──────>  laptop B (spoke)
                         ✗ A <──────────────> B
```

Install or refresh the local keepalive service and register this spoke:

```bash
devbox mutagen setup [--profile <id>] [--no-service] [--no-remote] [--json]
```

`setup` is idempotent, makes the supervised wrapper own the daemon, and hands over from
an on-demand daemon without killing a running sync. It writes/touches the spoke and hub
records on the remote only when a profile is selected and `--no-remote` is not passed;
with no profile or `--no-remote`, remote registry work is skipped. Re-run it after
upgrading Devbox. A pre-0.3.0 `~/.local/bin/devbox-mutagen-daemon` wrapper is reported as legacy
and unused after setup; it may then be deleted. `status` attempts to touch the selected
spoke's remote `lastSeenAt` when that spoke is already registered and the hub is
reachable; `--no-remote` skips the attempt. `spokes` only reads the registry.

On macOS the LaunchAgent runs the daemon as `ProcessType` `Standard`. Before 0.6.4 it was
`Background`, which puts the daemon and every ssh/ProxyCommand child under darwin
background QoS; on a loaded Mac those children starved until ssh failed with `Connection
timed out during banner exchange`. Re-run `devbox mutagen setup` after upgrading so the
service is reloaded with the new plist.

Inspect service, daemon, sessions, topology, and registry:

```bash
devbox mutagen status [--profile <id>] [--no-remote] [--json]
devbox mutagen logs [--lines <n>] [--json]       # default: 80; <n> must be a positive integer (>= 1)
devbox mutagen spokes [--profile <id>] [--json]
```

Status reports manager (`launchd`, `systemd-user`, or `none`), label, installed/loaded/
running state, pid, unit and log paths; the daemon binary, version, private data directory,
origin (`service`, `on-demand`, `unknown`, or `none`), pid, and last completed cycle; each
profile session and its alpha/beta endpoints, conflicts, problems, and topology verdict;
and the hub's reachability, registration, hub ID, live agent count, and spoke last-seen
records. It works without a profile and then reports binary, service, daemon, sessions
(all Devbox-owned), topology, and hints with `hub: null`. It exits `1` for a topology
violation or an installed service with no running daemon; a healthy status returns `0`
(an empty session set has verdict `no-sessions`). Session enumeration uses
`MUTAGEN_DISABLE_AUTOSTART=1`, so status does not start a daemon.

Control the service without terminating sessions:

```bash
devbox mutagen start [--json]
devbox mutagen stop [--json]
devbox mutagen restart [--json]
devbox mutagen delete [--json]       # alias: uninstall
devbox mutagen pause [--profile <id>] [--json]
devbox mutagen resume [--profile <id>] [--wake] [--timeout <s>] [--plain] [--json]   # = db sync --profile <id>
devbox mutagen flush  [--profile <id>] [--wake] [--timeout <s>] [--plain] [--json]   # = db sync --profile <id>
```

When installed, start/stop/restart use `launchctl bootstrap`/`bootout`/`kickstart` on
macOS or `systemctl --user start`/`stop`/`restart` on Linux. Before an installed
service is stopped or restarted, Devbox first runs graceful `mutagen daemon stop`,
then asks the service manager to stop/restart; the wrapper forwards SIGTERM to its
child daemon. Without a service, `start` and `stop` call `mutagen daemon start|stop`
directly, while `restart` calls `mutagen daemon stop` followed by `mutagen daemon start`.
After an installed restart, the app-private daemon should return within about 45 seconds.
Sessions keep their paused state across a daemon restart, and every Devbox session is
paused outside `db sync`. `pause` pauses every Devbox-owned session of the selected
profile. Devbox never leaves a session live-syncing, so `resume` and `flush` do not start
a continuous sync: both run one `db sync --profile <id>` (resume, flush, pause again).
`devbox mutagen status` adds a hint when a Devbox session is running while no `db sync`
holds the run lock (a lost pause); the next `db sync` pauses it. `delete` removes only the LaunchAgent or
systemd unit and wrapper; sessions and the Mutagen data directory remain. Sync-touching
commands (`status`, `pair`) start the daemon on demand and `sync` starts it through the
keepalive service; `devbox mutagen status` never does. `stop` and `restart` wait for a
running `devbox sync` to finish (they share its run lock), so a restart never lands
mid-sync.

The generated wrapper runs `mutagen daemon run` in a loop. If no managed binary is
available it logs the condition and retries after 300 seconds. If the child exits within
5 seconds (typically because an on-demand daemon owns the lock), it retries every 60
seconds and takes over when the lock is free; otherwise it restarts after 15 seconds. It
forwards termination signals to the child so service stop/restart cannot orphan a daemon.
Local state is relocatable with `DEVBOX_STATE_ROOT`.

All of these commands accept `--json` and use the standard envelope
`{ schemaVersion: 1, command, ok, operationKey, result }`; errors are
`{ schemaVersion: 1, command, ok: false, error: { code, message, retryable, context } }`.
Bootstrap results expose `.result.status` and `.result.steps[]`; status results expose
`.result.daemon.running`, `.result.service.running`, `.result.topology.verdict`,
`.result.hub.registered`, and `.result.sessions[].status`. Human bootstrap progress is
stderr and the final result is stdout; JSON output is stdout. Exit `0` means ready/ok,
exit `1` means blocked, failed, topology violation, installed service without a running
daemon, or another uncategorized failure; exit `2` is `invalid_argument` usage, exit
`3` is `devbox_operation_blocked`, exit `5` is an auth/bridge denial, exit `6` is a
propagated `operation_conflict`, and exit `130` is `cancelled`.

### Mutagen: the safe backend

Mutagen is the intended hot backend for portable working and declarative files. Its
session is configured as `two-way-safe`, with VCS ignored, neighboring staging, portable
permissions/symlinks, a profile-configured entry count (2,000,000 by default), and
app-owned labels. Credential roots are the documented exception: they are opt-in
allow-listed roots using `two-way-resolved`, while `two-way-safe` remains the rule for
working files. Clipboard-paste roots are the other exception and use `one-way-replica`
(the laptop is authoritative, the remote is a disposable mirror). A modify/modify,
delete/modify, type, permission, case, or Unicode conflict must remain visible; the
backend must not silently choose a last writer. The app-private Mutagen namespace is
separate from unrelated user Mutagen sessions, and the SSH transport is bound to the
profile's approved endpoint and host key.

Mutagen is an **external, non-bundled dependency** pinned to v0.18.1. Devbox resolves
it in this order: an optional `DEVBOX_MUTAGEN_BINARY` override, the managed cache at
`$HOME/.local/state/devbox/tools/mutagen-0.18.1/mutagen`, a PATH binary whose
`mutagen version` reports 0.18.x, alice's `$HOME/.local/opt/mutagen-*/extracted/mutagen`
layout, and finally an official GitHub release download verified by a pinned SHA-256
for the current supported platform. The downloaded executable is cached permanently.
The app-private `MUTAGEN_DATA_DIRECTORY=${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen`
namespace remains separate from unrelated user Mutagen sessions.

### rsync fallback: degraded-directional only

When Mutagen is unavailable, unapproved, or fails during creation, the supervisor can
select the rsync fallback if that backend is configured. It changes the request to
`directional`; the default direction is local-to-remote. Its status is
`degraded-directional`, its watch mode is `None`, and it does not provide a hot
watch-loop SLO.

This fallback is **not two-way-safe**. It is not equivalent to Mutagen and must never be
reported as a safe bidirectional mirror. It can perform an explicit directional seed or
repair using the shared exclusions and can retain conflict backups where the backend is
configured to do so. A directional resolution may only select the configured direction
as the winner. The current CLI does not expose the fallback's conflict listing,
backup, or resolution calls, so an operator cannot safely resolve a fallback conflict
from the CLI alone.

`devbox pair` starts the profile's supervisor and creates any missing session paused; it is not a promise that a
one-shot rsync transfer has just completed. `devbox status` reports `sync: degraded`
when any session exposes a Mutagen `lastError`, problem, or conflict, and includes the
actual last error plus per-session conflict/problem counts in human and JSON output.
`devbox disable` flushes and pauses each app-owned backend before it stops supervision.
If the flush, pause, or ownership check cannot complete, disable fails closed rather
than leaving an unverified active session.

## Authority and handoff

Working-file sync and stateful authority are separate:

- ordinary enrolled working files may be edited on both sides under the conflict-safe
  Mutagen mode;
- the stateful authority owns Git metadata mutation, active Phi session appends, and
  destructive reconciliation; and
- `.git`, live session files, credentials, and process state do not become ordinary hot
  sync data merely because a profile is paired.

The authority contract records an epoch with a monotonic sequence and an owner,
`local` or `remote`, in two witnesses: host-local and peer-observed. Managed Devbox
writers carry the epoch and are rejected when it is stale. Epochs do not expire merely
because a laptop slept or a network was down.

A handoff is a state transition, not a toggle. The authority manager's sequence is:

```text
prepare -> quiesce -> checkpoint -> reconcile -> verify -> commit-epoch -> resume
```

It quiesces registered managed writers, checkpoints recoverable state, reconciles the
stateful data, verifies the result, advances both witnesses, and resumes under the new
epoch. A failed or interrupted transition stays on the old epoch or rolls back; it must
not infer a committed handoff from elapsed time. A stale managed operation is rejected
with a stale-epoch error.

The fencing is **cooperative, not OS-enforced**. It applies to Devbox-managed Git,
Optional phi, job, and reconciliation operations. An arbitrary shell running as the same
Unix user can still write files or run Git. Devbox cannot prevent that write with an OS
lock. It can detect the resulting out-of-band state change and block verification or
handoff; it cannot claim that no external writer ran.

Phase 1 exposes whole-profile Git handoff for enabled roaming profiles:

```bash
devbox handoff --profile project-roam --to remote --json
devbox handoff --profile project-roam --to local --json
```

The controller flushes and verifies the existing sync sessions, pauses them without
terminating them, refreshes the passive clone from `origin`, adopts the published branch
and index, atomically parks the old `.git` directories, unparks the target, verifies the
manifest, commits the new epoch/witness marker, and resumes the same sessions. A clean
named branch with a current HEAD published at `origin` is required; refusal is safer than
selecting a winner. Fencing remains cooperative: a same-user process can explicitly
address `.git.devbox-parked`, and later inventory detects the drift.

An interrupted handoff is durable and resumable. Do not delete metadata or edit witness
files; run `devbox status --profile <id> --json`, then repeat the handoff. Recovery rolls
back before `commit-epoch` and preserves the candidate owner after `commit-epoch`. See
`docs/devbox-recovery.md`. Force takeover remains unavailable.

## Credential and auth-health plane

Credential declarations are references only. The broker classifies each capability as:

- **forwarded-only**: uses a live Devbox connection/agent-forwarding lease and becomes
  blocked when that connection is disconnected;
- **machine-enrolled**: delivered only after explicit enrollment on the trusted host;
- **OAuth-per-host**: authorized separately for the specific host; or
- **unavailable**: required, expired, revoked, blocked, or unsupported without a secret
  being placed in the profile.

Provider-auth declarations support GitHub, GitLab, Anthropic, OpenAI, Google, and
custom providers with either local-browser or remote-enrollment delivery. MCP OAuth is
represented as a remote-bridge capability. Secret writes use the broker's explicit
boundary, restrictive permissions, and redacted audit data. Generic sync excludes the
known auth files, OAuth caches/locks, SSH material, and other declared secret paths.
Devbox never copies the laptop's primary SSH private key as generic Devbox state.

The broker checks profile trust, endpoint, username, port, and host-key fingerprint
before delivery. A changed endpoint or host key blocks delivery until the exact target
is re-verified. The broker has capability probes, enrollment, OAuth authorization, and
machine-credential revocation internally, but the current IPC and `devbox` CLI expose
none of those operations. There is therefore no supported CLI command to print auth
health, enroll a machine credential, revoke it, or repair an expired provider token.

An auth failure is narrower than a sync failure: only dependent capabilities should be
unhealthy; ordinary file sync and terminal control should not be treated as proof that
a provider token is healthy. Never copy an auth cache into the workspace or attempt to
repair expiry by bypassing the credential broker.

## CLI reference

Profile selection is optional for profile-scoped commands. Devbox resolves it in this
order: explicit `--profile <id>`, `DEVBOX_PROFILE`, the configured default from
`devbox profile use <id>`, and finally the only saved profile when exactly one exists.
When selection is ambiguous, the error lists available IDs and shows both ways to set a
default. The common Devbox flags are `--profile <id>` and `--operation-key <value>`.
The global flags exposed by the standalone CLI are `--help`, `--json`, and `--version`;
`run` additionally accepts repeated `--env KEY=VALUE` entries for the remote job.
`--json` returns a stable envelope with secret-shaped fields redacted. The CLI retries
transient runtime failures up to two times; it does not retry a semantic safety refusal.
The installer also creates the `db` command as a symlink to `devbox` when that path is
available; both names use the same CLI and version.

### Human output and terminal modes

The default human renderer is an adaptive, terminal-aware presentation: it uses a
clear title and semantic status line, aligned key/value sections, and whitespace
separated tables. Tables read the available terminal width, remove lower-priority
optional columns before narrowing required columns, and truncate long cells without
wrapping. Use `--json` for the stable automation envelope; JSON output is never ANSI
styled.

Automatic colour is enabled only on a TTY. `NO_COLOR` disables ANSI colour whenever it
is present, even when its value is empty, and `TERM=dumb` disables colour as well.
Dumb terminals and non-UTF-8 locales use ASCII status symbols instead of Unicode.
`FORCE_COLOR=1` explicitly enables colour (including in a non-TTY or `TERM=dumb`
environment), while `FORCE_COLOR=0`, `false`, or `no` disables it.

Manage the preference without editing state files:

```bash
devbox profile list
devbox profile use <id>
devbox profile use --clear
```

The same default can be set by device alias. `devbox device --default <alias>` resolves
the alias (or a profile id; ids win, as with `--device`) and stores that profile as the
default exactly like `profile use <id>`; an unknown alias fails with the list of known
devices. `devbox device` (or `device ls`) lists alias, profile id and user@host with `*`
on the default (`--json` mirrors `profile list`), `devbox device --default` or
`devbox device default` shows the current default, and `devbox device --clear-default`
clears it like `profile use --clear`.

```bash
devbox device --default remote
devbox shell new agents   # routes to remote with no --profile/--device
```

### Lifecycle and status

```bash
devbox pair [--profile <id>] [--json]
devbox status [--profile <id>] [--json]
devbox disable [--profile <id>] [--json]
```

`pair` calls the runtime start operation. (Releases up to 0.5.3 also accepted `sync` as
an alias for it; `sync` is now the all-machines
[sync-now command](#sync-every-machine-now-devbox-sync).) A standalone-process `status` is
still read-only: it queries the app-private Mutagen namespace by the complete profile
label set, so it reports live sessions even when this CLI process did not create them.
`disable` stops app-owned synchronization only after its flush/pause verification,
terminates every live owned session, verifies that none remain, and stops the
app-private Mutagen daemon.

### Sync every machine now (`devbox sync`)

```bash
db sync [--profile <id>] [--device <alias>] [--wake] [--timeout <seconds>] [--plain] [--json]
```

`db sync` flushes every Devbox-owned Mutagen session on this machine (label
`devbox-backend=mutagen`) to every machine it is paired with, all machines at once, and
shows a live board while it works: workspace roots (`portable-*` root classes),
clipboard-paste images (`paste`), MCP credentials (`credentials`), optional phi sessions (if configured,
labelled `devbox-profile=phi-sessions`), and any other Devbox-labelled session. With no
flags it covers **all** machines; the default profile/device and `DEVBOX_PROFILE` never
narrow it. `--profile <id>` keeps one profile's lanes; `--device <alias>` keeps one
machine (its alias, its host, or the id of a profile on it). Unknown values fail with the
list of known ones.

A *machine* is one ssh endpoint (`user@host:port`): profiles that share an endpoint, and
optional label-only sessions such as `phi-sessions`, share a machine named by its device alias. A
*lane* is one local ↔ remote root pair of one profile. Each machine runs independently
and in parallel:

1. **Check.** A short SSH probe uses an 8 s connect budget and a 10 s cap (20 s behind a ProxyCommand). If `DEVBOX_POWER_CLI` names the executable behind a `proxy` command, Devbox first reads its `status` (`state: running|stopped`) without waking the host; `--wake` permits a probe of a stopped host with a four-minute budget. Without that optional setting no power-provider command is called. Operators should understand whether their own SSH proxy starts a stopped host before using it.
2. **Sync.** `before` hooks, then the sessions that were paused are resumed; once every
   endpoint reports connected, every session gets its own `mutagen sync flush`, all at
   once (one `flush a b c` call makes Mutagen force one session's cycle after another),
   while a shared `mutagen sync list` poll (every 500 ms) feeds the live view.
3. **Finish.** Every session of the machine is paused (one call per session, up to
   60 s each: Mutagen pauses a session once its running scan stops), including any the run
   found already running, then `after` hooks run. Devbox never leaves a session running.

A resume that fails with a connection error (ssh timed out, refused, reset, `exit status
255`, host-key or handshake trouble) is not a failure: Mutagen keeps the session unpaused
and retries the connection itself, so the machine stays `connecting` and the 30 s stall
rule decides. If it never connects it is skipped as `unreachable` with the ssh error as the
detail; any other resume error fails the machine.

Lanes finish independently: a lane whose own sessions finished flushing counts as `synced`
in the result even when another lane on the same machine later stalls, fails, or hits
`--timeout`. The machine still reports the skip or failure, its lane list shows which lanes
synced, and the `after` hook runs for every profile whose lanes all synced.

| Outcome                 | When                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| synced                  | the flush completed                                                      |
| skipped `unreachable`   | the probe failed (refused, auth, no answer in budget), or resume could not connect and the endpoint stayed down for 30 s |
| skipped `stopped`       | configured power provider reports stopped; no `--wake`                                   |
| skipped `stalled`       | the daemon reported an endpoint disconnected/connecting for 30 s mid-sync |
| skipped `timeout`       | the machine exceeded `--timeout` (default 900 s, `0` = no cap)          |
| skipped `interrupted`   | Ctrl-C or SIGTERM                                                        |
| failed                  | Mutagen's resume/flush error, or a halted session (`halted-on-root-*`)   |

A machine that is connected and still scanning a large tree is not hung; only the cap
stops it. Neither is a busy Mutagen daemon (or a loaded Mac) whose `sync list` polls time
out: after 10 s without a status answer the machine shows a muted `Mutagen busy · no status
for 0:20` note and keeps waiting for its flush, bounded only by `--timeout`. Time without a
status answer never counts toward the 30 s `stalled` rule. A skipped or failed machine is re-paused at once and never holds up the others.
A pause whose CLI call runs out of time is still in flight in the daemon; the run checks
`sync list`, warns `still pausing` only for sessions that are not paused yet, asks again
once at the end of the run, and the next `db sync` pauses whatever it finds running, so a
lost pause heals on the next round. Every
helper process (`devbox status`, `ssh -G`, the probe, hooks) runs under a hard cap in its
own process group, so a hung grandchild such as a hook's `ssh` cannot hold the run.
Every session in the run's scope is paused on every exit path (synced, skipped, failed,
Ctrl-C, error), including sessions that were already running when it started (they are
flushed but never resumed by the run). The
first Ctrl-C stops gracefully (kills the flushes, restores pause state, exit 130); a second
Ctrl-C exits immediately and leaves the re-pause to a detached `mutagen sync pause`. When the daemon is not answering, `sync` starts it once through
the keepalive service (as `devbox mutagen start` does) and fails cleanly if it cannot.

**Hooks.** An optional executable `<state root>/hooks/sync/<profile-id>`
(`~/.local/state/devbox/hooks/sync/<profile-id>` by default) runs as `<hook> before` after
its machine answered and before the sessions resume, and as `<hook> after` once every
lane of that profile flushed (even if another profile on the machine was skipped). It gets `DEVBOX_SYNC_PHASE`, `DEVBOX_SYNC_PROFILE`, `DEVBOX_SYNC_HOST`,
and `DEVBOX_SYNC_USER`, has 120 s, and its output is captured. A missing or
non-executable hook is a no-op; a failing or timed-out hook becomes a warning on that
machine's result and never fails the sync. Example generic hook to record a successful
flush for a profile (replace it with your own script as needed):

```sh
#!/bin/sh
# ~/.local/state/devbox/hooks/sync/workspace   (chmod +x)
set -eu
if [ "$DEVBOX_SYNC_PHASE" = after ]; then
  printf '%s: %s@%s synced\n' "$DEVBOX_SYNC_PROFILE" "$DEVBOX_SYNC_USER" "$DEVBOX_SYNC_HOST" >> "$HOME/devbox-sync.log"
fi
```

**Output.** On a terminal the board is redrawn on stderr and the summary stays on stdout;
`--plain` (or a non-TTY stderr, e.g. launchd/cron) prints timestamped progress lines
instead. `--json` prints only the final envelope (`.result.machines[]` with `state`,
`reason`, `detail`, `warnings`, and per-lane counts; `.result.syncedCount`,
`.result.skippedCount`, `.result.failedCount`, `.result.interrupted`). A lane's sessions
mirror one root pair, so its file, conflict, and problem counts are the largest session's,
not their sum. `synced · N files` appears only when a transfer was seen; a quick one can
fall between two polls, so a bare `synced` does not mean nothing changed.

**Exit codes.** `0` when nothing failed (skips are expected), `1` when a machine failed
(or the daemon could not be started), `130` when interrupted, `2` for usage errors.

**One run at a time.** `<state root>/sync.lock` records the running `{ pid, startedAt, command }`.
A second `db sync` waits and says what holds the lock (`another db sync`, `db mutagen
restart`, ...) and its pid (Ctrl-C leaves the wait); a lock
whose pid is gone is stale and replaced. `devbox mutagen stop` and `devbox mutagen
restart` take the same lock and print a note while they wait.

### Remote execution

#### Persistent terminal (`devbox shell`)

`devbox shell` resolves the selected profile using the same default-profile rules as
other bare commands, checks for remote tmux, and manages unlimited sessions at the
profile's remote root. Bare `shell` always attaches: it selects the most recently used
session, or creates session `1` when none exists. A fresh session is explicit with
`new`; names are optional friendly suffixes. Detach with `Ctrl-b d`, or simply close
the terminal window: tmux keeps the remote process running through either disconnect.

```bash
devbox shell [--profile <id>] [--no-reconnect]       # attach to MRU / create 1
devbox shell new [name] [--cwd <remote-dir>] [--run <command>] [--no-reconnect] [--profile <id>] # create at an override
devbox shell <id-or-name> [--no-reconnect] [--profile <id>] # attach an existing session
devbox shell resume [--no-reconnect] [--profile <id>] # resume this terminal's last shell
devbox shell reconnect [--profile <id>] # resume (alias for reconnect without --all)
devbox shell reconnect --all [--dry-run] [--worktree <selector>] [--profile <id>] # reopen detached shells (every device)
devbox shell ls [--profile <id>] [--refresh] [--json] # list and mark MRU
devbox shell rm <id-or-name> [--profile <id>]         # close one
devbox shell rm this [--profile <id>]                 # close the current session
devbox shell rm --unattached [--profile <id>]         # close detached sessions only
devbox shell rm --all [--profile <id>]                # close all owned sessions
```

`shell new --run <command>` types `<command>` into the fresh session's interactive login
shell exactly once, as if typed and followed by Enter, before attaching: aliases resolve
and the shell stays after the program exits. A tmux session option (`@devbox-run-sent`)
is set before the keys are sent, so automatic reconnects never type it twice. The
command must be one non-empty line of at most 4096 bytes; `--run` is rejected on every
verb except `new`. For example, `db shell new review --cwd /home/alice/work --run "git status"`
starts in a new session without depending on a particular agent.

#### Reconnecting after a dropped connection

When an interactive SSH child exits 255, `devbox shell` and `devbox shell new` remain in
place and offer to reconnect to the **same tmux session**. The stderr prompt is:

```text
devbox: connection lost (ssh exit 255) — reconnecting to shell #7 (betterssh) on alice@203.0.113.10 in 1s… [Enter] now · [q] quit
```

Retries continue forever with a 1-second-to-15-second backoff; an attach that stays
healthy resets the backoff. Enter or `r` retries immediately. `q`, Esc, Ctrl-C, or SIGINT
abandons the loop and points to `devbox shell resume`. `Ctrl-b d` remains a clean detach.

`devbox shell resume` (and `devbox shell reconnect` without `--all`) first selects the
session this terminal last attached to: Forca's `ORCA_TERMINAL_HANDLE` identifies a pane,
otherwise Devbox uses the tty. If that record is stale it falls back to the profile's
last-attached session, then the most recently used session, and writes a one-line stderr
notice for the fallback. With no sessions, it behaves like bare `devbox shell`.

`devbox shell reconnect --all` is an optional terminal-host integration with Forca;
Devbox's ordinary `shell`, `ls`, `resume` and manual attaches need no Forca installation.
When Forca is installed, this command opens one Forca terminal tab per detached session that
`devbox shell ls` lists, each running `devbox shell <tmux-session-name> --profile <profile>`
(the exact tmux name, because numeric ids can repeat) and titled with the session's name
(`#<id>` when unnamed; `<name>@<device>` when the same title appears on two devices).
Without `--profile`/`--device` it covers every configured device exactly as `shell ls`
does, using each device's own profile; unreachable or recently-failed devices are skipped
and reported, never failing the run. An explicit `--profile`/`--device` limits it to that
profile. This terminal's last detached session is resumed in place instead of in a tab, and
attached sessions are reported as skipped. It targets the worktree matching the current
directory, falls back to Forca's active worktree, and accepts `--worktree <selector>` as
an override. Use `--dry-run` to print the plan (device, tab title, action, command)
without opening tabs. Opening tabs requires the `forca` CLI and a reachable Forca runtime;
when either is unavailable, the error lists the same manual commands. `--json` returns the
plan/result (per-row `profileId`, `device`, `title`; `skippedDevices`) and never attaches in
place.

Pass `--no-reconnect` to `shell`, `shell new`, or `shell resume`, or set
`DEVBOX_SHELL_RECONNECT=0`, to opt out. Reconnect is disabled automatically for `--json`
and non-TTY output. Attach history is best-effort internal state at
`~/.local/state/devbox/shell-attach-history.json`, mode `0600`; hosts must not rely on it,
and it is safe to delete.

The table reports ID, friendly name, CREATED, ATTACHED, LAST-USED, and the pane's
current command/title; `*` marks the MRU session. IDs are stable until removal, and
new sessions take the lowest free positive ID. Devbox encodes the profile, ID, and
sanitized friendly name in the canonical tmux session name
(`devbox-<profile>-<id>[-<name>]`), with no extra mapping state. New sessions use the
private socket `devbox-${sha256(profileId UTF-8).hex.slice(0,12)}` and start their
owned server with `tmux -f /dev/null -L <socket>`. Discovery probes that socket first,
then the legacy default socket, preserving attach/remove access to existing sessions.
Unknown attach/remove targets fail without creating a session and list the existing
canonical sessions. `shell ls` never presents old name-only resources. A strictly
validated v0.1.5 `devbox-<profile>-<sanitized-name>` is cleanup-only.

`db shell rm this` requires inherited `TMUX` and `TMUX_PANE`. It resolves exactly one
current session through the local tmux client, refuses to continue if it is outside tmux,
if lookup fails, or if the session is not owned by the selected profile, and only then
uses the observed private/default socket to remove that exact session. Each refusal
reports its own reason; only a missing `TMUX`/`TMUX_PANE` reports "TMUX is not set". `this` is not an
MRU selector, a name wildcard, or a request to close more than one session.

`db shell rm --unattached` inventories both the deterministic private socket and the
legacy default socket, then considers only profile-owned canonical sessions and strictly
validated v0.1.5 name-only cleanup sessions. It removes a session only when tmux reports
its attachment field as exactly `0`; rows missing required session metadata are not
cleanup candidates, and any present attachment value other than exact `0` (including
unknown or malformed values) is treated as attached. The kill is guarded by a second
server-side detached check, so a session that becomes attached during the operation is
skipped. Each removal is an exact
`kill-session`; the command never uses `kill-server` or a wildcard and leaves foreign
or attached sessions untouched.

`db shell rm --all` removes every discovered owned canonical or validated legacy session,
including attached sessions, from both sockets. It is safe to repeat and to race with a
session disappearing, and it never kills either tmux server or touches foreign names.
The legacy `--name`, `--list`, and `--kill <id-or-name>` flags remain accepted as hidden
aliases.

The private server enables tmux 3.4 extended keys (without `extended-keys-format`),
mouse mode, a 100,000-line history limit, `set-clipboard on`, tmux's stock terminal
features (pinning `xterm*:clipboard:ccolour:cstyle:focus:title`), and pane-title
forwarding (`set-titles on`, `set-titles-string '#{pane_title}'`) before panes are created. Root wheel/drag guards forward mouse events
when pane/application mouse mode is active and otherwise enter copy mode. Copy-mode
wheel bindings select the pointer's pane before scrolling; drag release copies and
cancels. Normal keyboard and middle-click paste bindings remain stock. The plugin-free
status bar shows DEVBOX/host/session, active window, pane command, tail-truncated cwd,
COPY/PREFIX state, and time. The private server is the only server configured; Devbox
never edits `~/.tmux.conf` or rewrites a shared default socket. New shells resolve their
working directory as `--cwd`, then the profile shell directory, then the profile remote
root. Configure the persistent preference with:

```bash
devbox profile shell-dir set /home/<user>/projects
devbox profile shell-dir show
devbox profile shell-dir --clear
```

The selected directory must be an absolute path and Devbox checks `test -d` remotely
before creating a session. Existing sessions retain their current directory when attached.
Devbox only installs tmux via non-interactive `sudo -n`; when that path is unavailable it
prints the exact install command and does not prompt.

### Credential passthrough

The local control machine is authoritative for agent and MCP bearer credentials. Set a
profile's path once, then forget the plumbing:

```bash
devbox profile env-file set "$HOME/.config/devbox/secrets.env"
devbox profile env-file show
devbox profile env-file --clear
```

`set` normalizes the path to an absolute local path and persists only that path in the
profile JSON. Devbox parses the file at the instant of each shell attach/new and run;
blank lines, comments, CRLF, and `export KEY=VALUE` prefixes are accepted, while any
other malformed line fails with its line number. The values travel only as stdin on the
existing pinned OpenSSH channel. The remote script verifies `/dev/shm` is a `tmpfs`,
uses `umask 077`, atomically replaces `/dev/shm/devbox-<profile>.env`, and verifies
mode `0600`. It refuses to write a disk-backed fallback.

For shells, each key refreshes the target tmux session environment with targeted
`set-environment -t` calls using the session's private/default socket and the attach
command sources the staged file with `set -a`; new panes/windows inherit the refresh.
Already-running processes retain their old environment, so rotate the file locally and
reattach or restart the process. For jobs, Devbox uses
`systemd-run --property=EnvironmentFile=/dev/shm/devbox-<profile>.env`. Existing filtered
`--env` entries are placed first; the profile env-file is placed on top and wins for a
duplicate key. The env-file values are not placed in argv, logs, status, or JSON.

This is memory-backed, not same-user isolation: the staged tmpfs file and tmux
`show-environment` are readable by the same Unix user on the VM. A reboot clears the
staging file. `devbox disable`, `devbox shell rm --all`, and clearing the preference
best-effort remove it. OAuth-MCP grants remain per-machine grants and are not changed by
this file passthrough; only the local env-file delivery path changes.

The `devbox phi` command is an optional integration for installations with phi and its
session bridge; `devbox run` and `devbox git` do not require phi.

```bash
devbox phi [--profile <id>] --path <local-path> \
  --session-id <id> --relay-epoch <epoch> [--json]
devbox run [--profile <id>] [--id <job-id>] [--cwd <path>] \
  [--env KEY=VALUE ...] [--consistent] -- [argv...]
devbox git [--profile <id>] --path <local-path> -- [git argv...]
```

If you enable the optional phi bridge, `devbox phi` requires a caller-provided session ID and relay epoch. `devbox run` defaults to consistent mode, generates an ID when omitted, uses the
profile's remote root as its cwd when omitted, always creates a detached job, verifies
that the remote generation workspace exists before launching systemd, and requires argv
after `--`. `--consistent` remains accepted for scripts as a no-op. Without `--attach` it
returns once the job is registered and observed running;
`--attach` keeps the command in the foreground until the job reaches a terminal state
and Ctrl-C requests cancellation. Repeat `--env KEY=VALUE` for multiple environment entries;
each value must be `KEY=VALUE`. Job output is sensitive workload data and is not
included in JSON output; JSON reports whether log text is available.

`devbox git` requires `--path` and is authority-aware for roaming profiles. Reads work on
either side; on a passive side the managed proxy points at `.git.devbox-parked`, disables
optional Git locks, and filters the parked directory from status. Mutations,
`--git-dir`/`-C`/`-c` overrides, shell escapes, and unknown or ambiguous commands fail
before Git starts with a pointer to `devbox handoff --to <side>`. A plain raw Git command
on a passive side intentionally fails as “not a git repository”. Non-roaming profiles
retain the existing remote-terminal behavior. The command does not intercept an
unrelated `/usr/bin/git` invocation in an external shell.

### Jobs and ports

```bash
devbox jobs status [--profile <id>] --job-id <id> [--json]
devbox jobs cancel [--profile <id>] --job-id <id> [--json]
devbox jobs log [--profile <id>] --job-id <id> \
  [--offset <n>] [--limit <n>] [--json]
devbox ports open [--profile <id>] --remote-port <port> \
  [--public] [--label <text>] [--json]
```

Jobs are keyed by job ID and full command specification hash. If the remote registry
already has that ID, `devbox run` attaches to it; it does not launch a second command.
Use a new ID for a deliberate retry after a failed job. `jobs log` reads a bounded tail;
`--offset` and `--limit` are integers greater than or equal to zero. `ports open` uses the exact profile
SSH endpoint (including user, port, and pinned known_hosts file), prints the bound
loopback address, and remains in the foreground until SIGINT/SIGTERM; either signal
closes the forward cleanly. The public-listener acknowledgement flag in this
implementation is `--public`; `--allow-public-listener` is not a valid Devbox CLI flag.

### Registered but blocked commands

These names are real command specs, but each handler fails before contacting the
runtime because its T-006 IPC channel is not implemented:

```bash
devbox doctor [--profile <id>] [--json]
devbox repair [--profile <id>] [--json]
devbox conflicts [--profile <id>] [--json]
devbox support [--profile <id>] [--json]
```

`handoff` is implemented for enabled Phase 1 roaming profiles. It is not an alias for
`status`, `sync`, or manual file operations.

## Status and error interpretation

Use `--json` when recording an incident. Lifecycle results include the profile ID,
state, generation ID when available, whether the journal was restored, and an observed
time. Sync status can additionally report `running`, `paused`, `degraded`, or
`unavailable`, its backend capability, watch mode, conflict count, lag observation, and
fallback reason. Enabled roaming profiles add `gitRoaming`: owner/epoch/transition,
checksummed witness health, working-tree-only topology, repository count, dirty and
unpublished counts, passive-refresh freshness, sync barrier, and explicit cooperative
fencing. Human output says “private `.git` metadata; working-tree-only sync” so a green
sync line is not mistaken for Git metadata replication.

Common Devbox error codes are:

| Code                                                | Operator meaning                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `profile_not_found`                                 | The requested saved profile does not exist.                                |
| `profile_malformed` / `profile_version_unsupported` | The profile was rejected; do not hand-edit it as a recovery.               |
| `offline`                                           | The profile is not started or its SSH/runtime path is unavailable.         |
| `operation_conflict`                                | A serialized operation or safety precondition blocked the request.         |
| `ssh_identity_mismatch`                             | The endpoint or approved host key changed; stop and re-verify.             |
| `auth_required`                                     | A dependent credential capability needs authorization.                     |
| `disk_pressure`                                     | A capacity guard blocked the operation.                                    |
| `journal_corrupt` / `journal_truncated`             | Explicit journal recovery is required; there is no CLI repair command yet. |

Do not interpret a green-looking terminal as proof that the sync mirror, stateful
authority, and credential capabilities are all healthy. Check those planes separately.
For command-by-command recovery, use [`devbox-recovery.md`](devbox-recovery.md).
