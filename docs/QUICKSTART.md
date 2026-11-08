# Devbox quickstart

> First-time local + remote setup: [AGENT-SETUP.md](../AGENT-SETUP.md).

Devbox is a standalone CLI for a resilient roaming development workspace: an approved
Linux host is the execution machine, your Mac remains the control surface, and the
workspace's portable files stay synchronized over pinned OpenSSH and Mutagen. The same
profile can run consistent detached jobs under the remote user's `systemd --user`, read
job logs, and forward ports without copying credentials or treating Git metadata and
runtime state as ordinary two-way files.

## Install and use with zero required environment variables

Download and inspect the public installer from the [latest release](https://github.com/exowatt-oss/devbox/releases/latest), then run `sh ./devbox-install.sh`. No account or token is required. See [INSTALL.md](INSTALL.md) for source builds and upgrades.

## Human output and terminal modes

The default human renderer is adaptive: titles and semantic status lines are easy to
scan, key/value fields stay aligned, and whitespace tables use the available terminal
width. At narrow widths, lower-priority optional columns disappear before required
columns are narrowed; long cells are truncated rather than wrapping into a broken
table. `--json` remains the machine-readable path and never includes ANSI styling.

Automatic colour is enabled only for a TTY. `NO_COLOR` disables it whenever the
variable is present, including `NO_COLOR=''`; `TERM=dumb` also disables colour and
selects ASCII status symbols. A non-UTF-8 locale likewise uses ASCII symbols.
`FORCE_COLOR=1` explicitly enables ANSI colour, while `FORCE_COLOR=0`, `false`, or
`no` explicitly disables it. For `db init`/`db connect`, human step progress is written
to stderr and the final rendered result to stdout; `--json` writes only the standard
JSON envelope to stdout. Scripts should inspect both the envelope's `ok`/`result` fields
and the process exit code: `0` is successful/ready, `1` is blocked/failed or an
unhealthy Mutagen status, `2` is usage (`invalid_argument`), and a propagated
`operation_conflict` exits `6`.

## Shell sessions across multiple devices

With multiple profiles configured, `db shell ls` without `--profile` or `--device`
queries every configured SSH device once, in parallel and in one round trip per host,
and groups its sessions (NAME, ID, attached/detached, AGE, CWD). On a terminal each
device shows a live status line and prints as soon as it answers; unreachable devices
get one dim line and are skipped for 60 s afterwards (`--refresh` retries). A target name is searched
across devices; a unique match is selected automatically (use `--device` for an
ambiguous target). Use `db shell rm --unattached --all-devices` to clean detached
sessions everywhere. Inside a Devbox shell, `db shell rm this` kills the current local
tmux session directly, so it works even when the hub has no self-SSH profile.

To make one device the default for every command that gets no `--profile`/`--device`,
run `db device --default <alias>` (a profile id also works; it is `db profile use <id>`
by alias). `db device` lists devices with the default marked, `db device --default`
shows it, and `db device --clear-default` clears it.

```sh
db device --default remote
db shell new agents      # opens on remote, no --device needed
```

## Turnkey setup: `db init` / `db connect`

For a new workspace, the machine that already has the files seeds an Ubuntu hub:

```sh
db init --host <hub-host> --user <hub-user> --local-root <absolute-local-root> [--remote-root <absolute-remote-root>] [--profile <id>] [--port <n>] [--fingerprint <sha256>|--yes] [--env-file <path>] [--shell-dir <remote-dir>] [--adopt-remote] [--no-service] [--no-pair] [--force] [--json]
```

The default profile is the local-root basename sanitized to `[A-Za-z0-9._-]` (every
other character becomes `-`, capped at 64 characters; it must start with an alphanumeric
character or falls back to `devbox`). The default remote root is the remote user's
`$HOME` plus that basename; SSH
port defaults to 22. The local root is the seed and may contain files. The remote root
must be missing or empty unless `--adopt-remote` is explicit; adoption is two-way-safe
and differing files become conflicts, never deletions. `init` runs the ordered steps
`local-root`, `host-key`, `profile`, `remote`, `preflight`, `default-profile`,
`env-file`, `shell-dir`, `service`, `pair`, `hub-registry`; `env-file` and `shell-dir`
are `skipped` when not requested. It saves the profile, runs read-only preflight,
installs the local Mutagen keepalive service, creates spoke-to-hub sessions, and writes
hub/spoke registry records. Use `--no-service` to skip the service step. `--no-pair`
skips pairing and deliberately leaves `result.status: "blocked"` (exit `1`) so the
profile can be paired later. A blocked preflight likewise leaves the profile saved but
unpaired.

To join an existing hub from another Mac or Linux machine:

```sh
db connect --host <hub-host> --user <hub-user> --remote-root <absolute-remote-root> [--local-root <absolute-local-root>] [--profile <id>] [--port <n>] [--fingerprint <sha256>|--yes] [--env-file <path>] [--shell-dir <remote-dir>] [--allow-non-empty-local] [--no-service] [--no-pair] [--force] [--json]
```

The default profile is the basename of `--remote-root` sanitized to `[A-Za-z0-9._-]`
(other characters become `-`, capped at 64 characters; it must start with an
alphanumeric character or falls back to `devbox`). The default local root is `<local
$HOME>/<basename(remote-root)>`. The remote root must exist and is
the source of truth; an unregistered root receives its hub record. The local root must be
missing or empty unless `--allow-non-empty-local` is explicit. With an empty local root
the first sync pulls the hub into it; with the override, differing files become
two-way-safe conflicts rather than deletions. Both commands report the ordered bootstrap steps
(`local-root`, `host-key`, `profile`, `remote`, `preflight`, `default-profile`,
`env-file`, `shell-dir`, `service`, `pair`, `hub-registry`) as `ok`, `skipped`, `warning`,
or `failed`; optional settings are represented as `skipped` when absent. They then end
`result.status` `ready`, `blocked`, or `failed`; `--no-pair` deliberately produces
`blocked`. For a completed bootstrap, exit `0` means `ready` and exit `1` means
`blocked`/`failed`; usage errors are exit `2` and propagated operation conflicts are exit
`6`.

A workspace has one remote hub and N local spokes. Every session is local root →
`ssh://<hub user>@<hub host>/<hub root>`; spokes never sync with each other and a spoke
root cannot become another machine's hub. For both `db init` and `db connect`,
`hub-is-local` is refused before any bootstrap step with an error envelope code
`operation_conflict` and exit `6`. `hub-root-is-a-spoke` is refused in the `remote`
step for both commands, producing `result.status: "failed"` and exit `1`; the
`hub-registry` warning path is not reached. The service and registry details are in the
[agent setup runbook](../AGENT-SETUP.md).

## Manual profile creation (advanced)

A profile pins one SSH endpoint, its host key, and an absolute local/remote root pair.
For a new or disposable workspace, guard both roots before creating the profile; do not
adopt a directory that already contains data:

```sh
PROFILE=roam
HOST=203.0.113.10
USER=alice
LOCAL_ROOT="$HOME/scratch/roam"
REMOTE_ROOT=/home/alice/roam

# Create only missing roots. Stop instead of adopting either non-empty root.
if [ -e "$LOCAL_ROOT" ] && [ -n "$(find "$LOCAL_ROOT" -mindepth 1 -print -quit)" ]; then
  printf 'Refusing non-empty local root: %s\n' "$LOCAL_ROOT" >&2; exit 1
fi
mkdir -p "$LOCAL_ROOT"
ssh "$USER@$HOST" 'set -eu
  root=/home/alice/roam
  if [ -e "$root" ] && [ -n "$(find "$root" -mindepth 1 -print -quit)" ]; then
    printf "Refusing non-empty remote root: %s\\n" "$root" >&2; exit 1
  fi
  mkdir -p "$root"'
```

Scan the endpoint, choose the exact SHA-256 fingerprint you reviewed, and pass it to
`profile create`. `--fingerprint` is the pin; `--yes` accepts the scanned host keys
without an interactive prompt. The profile writes its private `known_hosts` file under
local Devbox state.

```sh
ssh-keyscan -T 10 -p 22 "$HOST" > /tmp/devbox-known-hosts
ssh-keygen -lf /tmp/devbox-known-hosts -E sha256
FINGERPRINT='SHA256:<reviewed-host-key>'

devbox profile create \
  --profile "$PROFILE" \
  --host "$HOST" \
  --port 22 \
  --user "$USER" \
  --local-root "$LOCAL_ROOT" \
  --remote-root "$REMOTE_ROOT" \
  --fingerprint "$FINGERPRINT" \
  --yes
rm -f /tmp/devbox-known-hosts
```

If `--fingerprint` is omitted, the CLI can accept the first key returned by
`ssh-keyscan` when `--yes` is supplied. Pinning is preferred. A profile ID may not be
overwritten unless `--force` is explicitly passed; do not use `--force` as a routine
recovery action.

Run the read-only checks, then start the paired profile. With one saved profile, Devbox
resolves the profile automatically, so everyday commands stay short:

```sh
devbox preflight --profile "$PROFILE" --json
devbox profile use "$PROFILE"
devbox pair --json
devbox status --json
```

For a multi-profile machine, keep the explicit form when you need a different target:

```sh
devbox status --profile "$PROFILE" --json
```

Preflight must report `status: "ready"` with no blockers. It checks the exact endpoint
and host key, Ubuntu 22.04/24.04 on amd64 or arm64, reviewed sudo access, a running user systemd
manager, user linger, required tools, capacity, and path safety. Pairing returns a
`ready` profile and creates the app-owned sync sessions **paused**: Devbox never syncs
continuously. Run `db sync` to sync every machine now, on demand or from a timer (see
[`db sync`](devbox.md#sync-every-machine-now-devbox-sync)); it resumes, flushes, and
pauses the sessions again:

```sh
devbox pair --json
devbox status --json
```

## Sync behavior and safety

The backend is Mutagen v0.18.1 in `two-way-safe` mode for the portable class the
profile's path map routes to (`portable-working` by default; one session per root pair).
Sessions stay paused and sync only during `db sync`. Both roots may receive ordinary
portable-file edits. Mutagen preserves modify/modify, delete/modify, type, permission,
case, and Unicode conflicts for review; it does not silently choose a last writer.
`devbox-backend=mutagen` sessions are private to the profile and are labeled with the
complete set below:

```text
devbox-backend=mutagen
devbox-profile=<profile-id>
devbox-root-class=portable-working | portable-declarative
devbox-session=<profile-id>-portable-working | <profile-id>-portable-declarative
```

`two-way-safe` does not mean every path is a replica. Git metadata (`.git`), active agent
sessions (including optional phi sessions), credentials and OAuth state, databases, sockets, package stores, virtual
environments, generated/build output, and stateful services are excluded or handled by
their own authority policy. If Mutagen is unavailable, the configured rsync fallback is
directional and degraded; it is **not** a safe two-way mirror. Check `sync.capability`,
`sync.state`, `sync.watchMode`, `sync.conflictCount`, per-session
`problemCount`/`lastError`, and observation freshness in JSON status before treating a
profile as healthy.

Mutagen scan limits are profile state, not process flags. Inspect or change the limit
without pairing or touching a current session:

```sh
devbox profile sync-max-entry-count show
devbox profile sync-max-entry-count set 2000000
devbox profile sync-max-entry-count --clear
```

The default is 2,000,000 entries and is passed when a new Mutagen session is created.
`devbox status` makes a session's `lastError`, problems, and conflicts visible and
reports the sync state as `degraded` instead of claiming readiness.

`db mutagen setup` installs or refreshes the keepalive service and makes it own the
app-private daemon. It registers the spoke only when a profile is selected and
`--no-remote` is not passed; with no profile or `--no-remote`, remote registry work is
skipped. `db init` and `db connect` run that setup automatically unless `--no-service`
is supplied. `pair` may start the daemon on demand when no service is
installed; status probes do not start it (`MUTAGEN_DISABLE_AUTOSTART=1` is
used while listing sessions). `shell`, `run`, `jobs`, and `ports` do not start it. Use
`db mutagen status` to inspect the service, daemon origin, sessions, topology, and hub
registry; without a profile it still returns binary/service/daemon/session/topology fields
but has no hub. With a selected profile it attempts to update the spoke's remote
`lastSeenAt` when that spoke is already registered; `--no-remote` skips the attempt.
`devbox mutagen logs --lines <n>` accepts a positive integer only (default `80`; minimum
`1`, so `0` is rejected). `db mutagen start|stop|restart` controls the daemon without terminating sessions. No default `--max-staging-file-size` is passed (Devbox `>= 0.2.17`);
sessions created by older releases carry a 100 MB cap that makes every larger file
re-transfer on every cycle (failure mode 10), so disable and pair such profiles again
after upgrading.

To change only Mutagen's watch detection cadence for a profile, use the optional
per-profile override:

```sh
devbox profile sync-watch-polling-interval show
devbox profile sync-watch-polling-interval set 60
devbox profile sync-watch-polling-interval --clear
```

The unset value keeps the unchanged 10-second default. This does not add ignores, reduce
the max-entry count, or shrink the full configured `~/project` two-way-safe tree; it only
changes how often polling detects changes. The value is applied when a new session is
created. Disable and pair again to recreate existing sessions; Devbox will not silently
adopt an existing session whose effective interval differs or cannot be verified.

### Git roaming (Phase 1)

For an already-real pair of clone sets, use `--git-roaming --dry-run --json` before
saving the profile, then pair only after the named repository preflight is clean. Git
metadata stays private: the passive clone has `.git.devbox-parked`, while working files
continue through the existing sync channel. Reads via `devbox git` work on either side;
mutations require the cooperative whole-profile handoff:

```sh
devbox handoff --profile "$PROFILE" --to remote --json
devbox status --profile "$PROFILE" --json
devbox handoff --profile "$PROFILE" --to local --json
```

Handoff requires a clean named branch with a published HEAD at `origin`; an interrupted
handoff is resumable. Do not rename metadata by hand. See `docs/devbox.md` and
`docs/devbox-recovery.md` for fencing, crash recovery, and the Phase 2 exclusions.

## Run jobs and read logs

Runs are consistent by default: Devbox verifies and materializes a remote generation
before launching the command, so the job does not run against an unverified workspace.
Jobs are detached by default, IDs are generated when omitted, and the profile's remote
root is the default working directory:

```sh
devbox run -- pnpm build
# prints the generated job ID prominently

devbox jobs status --job-id <job-id> --json
devbox jobs log --job-id <job-id> --json
```

Pass `--consistent` when scripting for clarity; it remains accepted as a no-op. Use
`--profile`, `--id`, and `--cwd` when you need to override the defaults.

Use a new job ID for a deliberate retry after a terminal failure. Reusing an ID attaches
to the existing registry record and does not launch a duplicate command. Add
`--attach` to `run` when the CLI should remain in the foreground until the job ends;
Ctrl-C requests cancellation. `jobs log` is a bounded tail; its output can contain
sensitive workload data.

## Persistent terminal (`devbox shell`)

`devbox shell` is a multi-session manager for tmux terminals on the selected profile's
remote host. Every invocation enters a shell: bare `shell` attaches to the most recently
used session, or creates session `1` when the profile has none. Sessions survive network
drops and closed terminal windows; use `Ctrl-b d` to detach cleanly.

### Running db on the hub itself

Copy the spoke's profile JSON to `~/.local/state/devbox/profiles/` on the hub. When a profile endpoint is the hub itself, Devbox runs its commands locally without SSH; only shell commands are meaningful there.

```sh
devbox shell             # attach to MRU, or create and attach session 1
devbox shell new         # create the next fresh session and attach
devbox shell new agents  # create a fresh session with the friendly name "agents"
devbox shell 1           # attach by stable numeric id
devbox shell agents      # attach by friendly name; unknown names fail with a listing
devbox shell ls          # list this profile's sessions; add --json for scripts
devbox shell resume      # reattach to this terminal's last shell
devbox shell reconnect --all  # optional Forca integration: reopen detached shells in tabs
devbox shell rm 2        # close one named/id session
db shell rm this         # close exactly the current Devbox-owned session
db shell rm --unattached # close only detached sessions for this profile
db shell rm --all        # close every owned session on both supported sockets
```

### Reconnecting after a dropped connection

When the SSH transport drops with exit 255, an interactive `shell` or `shell new` stays
in this terminal instead of returning to the local prompt. Devbox prints a prompt such as:

```text
devbox: connection lost (ssh exit 255) — reconnecting to shell #7 (betterssh) on alice@203.0.113.10 in 1s… [Enter] now · [q] quit
```

It retries the **same tmux session** forever with a 1-second-to-15-second backoff. A
healthy attach resets the backoff; press Enter or `r` to retry immediately. Press `q`,
Esc, or Ctrl-C to abandon the loop; Devbox tells you to run `devbox shell resume`. A
clean tmux detach (`Ctrl-b d`) still exits normally.

`devbox shell resume` (also `devbox shell reconnect` without `--all`) reattaches to the
session this terminal last used. In a Forca pane it uses `ORCA_TERMINAL_HANDLE`; otherwise
it uses the tty, then falls back to the profile's last-attached session and finally the
most recently used session, with a one-line stderr notice for a fallback. With no sessions
it behaves like plain `devbox shell`.

`devbox shell reconnect --all` is an optional Forca terminal-host integration. Without
Forca, use `devbox shell ls` and attach sessions with `devbox shell <id-or-name>`.
With Forca installed, it lists sessions like `devbox shell ls` (every device unless
`--profile`/`--device` narrows it; unreachable devices are skipped and reported), resumes
this terminal's last detached session in place, skips already-attached sessions, and opens
each other detached session in a Forca terminal tab titled with its name and running
`devbox shell <tmux-session-name> --profile <profile>`. It targets the worktree matching
the current directory, falls back to Forca's active worktree, and accepts
`--worktree <selector>` as an override.
`--dry-run` prints the plan (device, tab title, command) without opening tabs. Opening
tabs requires the `forca` CLI and a reachable Forca runtime; failures list the same manual
commands. `--json` returns the plan/result without attaching in place.

Pass `--no-reconnect` to `shell`, `shell new`, or `shell resume`, or set
`DEVBOX_SHELL_RECONNECT=0`, to opt out. Reconnect is also disabled automatically for
`--json` and non-TTY output. Attach history is best-effort local state at
`~/.local/state/devbox/shell-attach-history.json` (mode `0600`); it is internal and safe
to delete.

The list shows ID, friendly name, creation time, attached state, last-used time, and
pane command/title; `*` marks the most recently used session. IDs are stable for a
session's lifetime, then the lowest free positive ID is reused. Canonical session names
are profile-scoped tmux names (`devbox-<profile>-<id>[-<name>]`), so there is no local
mapping file to drift. New sessions use the private socket
`devbox-${sha256(profileId UTF-8).hex.slice(0,12)}` and are started with
`tmux -f /dev/null -L <socket>`. Devbox probes that socket first and the legacy default
socket second, so sessions made by older releases remain attachable and removable.
`shell ls` reports only canonical sessions; validated v0.1.5 name-only sessions are
cleanup-only. `rm <id-or-name>` accepts a canonical id/name or a legacy friendly/full
name.

`db shell rm this` is an exact current-session operation. It requires inherited `TMUX`
and `TMUX_PANE`, resolves one session with the local tmux client, refuses a foreign or
unresolvable session before SSH, and then removes only that profile-owned session on
the socket from which it was observed. It never treats `this` as a wildcard or as an
MRU shortcut.

`db shell rm --unattached` inventories both the private profile socket and the legacy
default socket, considers only profile-owned canonical sessions and strictly validated
v0.1.5 name-only cleanup sessions, and removes only sessions whose tmux attachment
field is exactly `0`. Rows missing required session metadata are not cleanup
candidates; any present attachment value other than exact `0` (including unknown or
malformed values) is treated as attached. A server-side exact-session check is repeated
at kill time, so an attach race is skipped.
It uses one exact `kill-session` per proven target, never `kill-server` or a wildcard,
and leaves foreign and attached sessions alone.

`db shell rm --all` removes every discovered profile-owned canonical or validated legacy
session, including attached sessions, on both sockets. It is safe to repeat, handles a
session disappearing during cleanup, never kills a tmux server, and never touches
foreign names. `--profile <id>` applies to every verb. The old `--list`, `--kill
<id-or-name>`, and `--name <name>` forms remain accepted as hidden aliases.
`devbox shell ls --json` is also available for automation.

### Optional phi / coding-agent login from a devbox shell

While an interactive shell is attached, Devbox watches the hub's OAuth callback ports
`53692` (Anthropic), `1455` (Codex), and `1456` (radius). When a listener appears, a
short-lived local callback is forwarded over the SSH session; it is removed as soon as
the login completes. No callback listener is kept after the shell exits. Disable this
with `--no-login-relay` or `DEVBOX_SHELL_LOGIN_RELAY=0`. If the relay is unavailable,
copy the final `http://localhost:...` redirect URL and paste it into the phi prompt
(the manual fallback shown by `/login`); login state and credentials remain on the hub.

Flow in practice: run `/login anthropic` in phi inside the devbox shell, open the URL it prints
in your local browser (cmd-click or copy), approve, and the browser's redirect to
`http://localhost:53692/callback` lands on the hub's phi through the attached shell. The
port list is overridable with `DEVBOX_LOGIN_RELAY_PORTS=53692,1455`; each relayed callback
(device, port, path — never the code) is appended to `~/.local/state/devbox/logs/login-relay.log`.
Forca-launched tabs (if you use that optional terminal host) are not `db shell` attaches and have no relay: use the manual paste there.

The first shell/list/rm operation checks for `tmux`. If it is absent, Devbox uses only
non-interactive `sudo -n apt-get install -y --no-install-recommends tmux`; if that is
unavailable, it prints the exact command to run and never prompts. New private Devbox
servers enable tmux 3.4 extended keys (without `extended-keys-format`), mouse mode,
100,000 lines of history, `set-clipboard on`, tmux's stock terminal features (pinning
`xterm*:clipboard:ccolour:cstyle:focus:title`), and pane-title forwarding
(`set-titles on`, `set-titles-string '#{pane_title}'`) before panes are created. Stock-compatible root mouse guards forward events when the
pane/application owns mouse input and otherwise enter copy mode; copy-mode wheel selects
the pane under the pointer and drag release copies/cancels. Normal keyboard and
middle-click paste bindings remain stock. The plugin-free status bar shows DEVBOX,
host/session, active window, pane command, tail-truncated cwd, COPY/PREFIX state, and time.
Devbox never changes `~/.tmux.conf` or the user's shared default server.

New shells use the profile's remote root by default. Set a persistent remote directory,
inspect it, or clear it with:

```sh
devbox profile shell-dir set /home/alice/projects
devbox profile shell-dir show
devbox profile shell-dir --clear
```

The directory is checked remotely when a session is created. A one-off `--cwd` wins over
the profile setting and is available only for `shell new`; resolution is `--cwd`, then
profile shell-dir, then the profile remote root:

```sh
devbox shell new polish --cwd /home/alice
```
Missing or non-directory paths fail before Devbox creates a tmux session. Existing
sessions keep their current working directory when attached, and `ls`/`rm` are unaffected.

## Credential passthrough (local-authoritative)

Keep the Mac's credential file as the only durable copy and configure its path once per
profile. The profile stores only this absolute path, never a credential value:

```sh
devbox profile env-file set "$HOME/.config/devbox/secrets.env"
devbox profile env-file show
# devbox profile env-file --clear   # remove the preference
```

On every `devbox shell` attach/new and every `devbox run`, Devbox reads the local file
again and sends its parsed `KEY=VALUE` entries over the profile's pinned SSH channel as
stdin. The remote side refuses a missing or non-tmpfs `/dev/shm`, writes
`/dev/shm/devbox-<profile>.env` with `umask 077` and mode `0600`, and never falls back to
the VM disk. Shell attaches refresh each tmux session's environment with targeted tmux
`set-environment -t` calls (using the same private profile socket for new sessions) and
source the file for the shell being attached; new panes/windows inherit the refreshed values. A process
that was already running keeps its old environment until it is restarted. `run` passes
`--property=EnvironmentFile=/dev/shm/devbox-<profile>.env` to `systemd-run`; explicit
filtered `--env` entries are applied first and the profile env-file is applied on top.

Values never appear in SSH argv, Devbox status/JSON output, or Devbox logs. The staging
file is memory-backed but readable by the same remote Unix user (as is tmux's
`show-environment`), so this is one trust domain rather than a same-user isolation
boundary. Reboot clears `/dev/shm`; `devbox disable`, `devbox shell rm --all`, and
clearing the preference best-effort remove the staged file. Rotate `secrets.env` on the local machine
and reattach or start a new pane/job to propagate fresh values. An invalid line is
rejected with its line number instead of being guessed or mangled.

## Open a port

Port forwarding is foreground-only. The command prints the local binding and stays in
the foreground until `SIGINT`/`SIGTERM`; Ctrl-C closes the forward cleanly:

```sh
devbox ports open --remote-port 8080
```

Use `--label "my service"` for an operator label. Add `--public` only when you have
intentionally approved a non-loopback listener; it is the actual v0.1.6 acknowledgement
flag (`--allow-public-listener` is not valid).

## Inspect and disable safely

Use human output for a quick check and JSON when recording evidence:

```sh
devbox status
devbox status --json
```

`devbox disable` is the cleanup boundary for a running profile. It flushes and pauses
each app-owned backend, terminates every session carrying the complete Devbox label set,
verifies that no owned sessions remain, stops the private Mutagen daemon, and performs
only profile-scoped remote agent cleanup. If any ownership, pause, flush, or verification
step cannot be proven, disable fails closed; do not replace it with a global `pkill`, a
global `mutagen daemon stop`, or broad `rsync --delete`:

```sh
devbox disable --json
```

## State and automatic Mutagen resolution

Local state defaults to `${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}`:

```text
${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/profiles/       profiles, operations, and pinned known_hosts
${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/generations/    local generation and recovery data
${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen/        private Mutagen data directory
```

The remote state root is
`$HOME/.local/state/devbox/<profile-id>`; job units use the `devbox-*.service` prefix
under the remote user's `systemd --user`. The remote workspace itself is the profile's
configured `remote-root` (for example `/home/alice/roam`). The local Linux keepalive unit
is `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/devbox-mutagen-daemon.service`;
macOS uses `~/Library/LaunchAgents/org.devbox.mutagen-daemon.plist`. To inspect
only Devbox's Mutagen sessions:

```sh
"$HOME/.local/state/devbox/tools/mutagen-0.18.1/mutagen" sync list
```

The CLI uses the same resolver for every Mutagen operation: optional override, managed
cache, a PATH binary reporting 0.18.x, alice's extracted opt layout, and then a
SHA-256-verified official download. The downloaded executable is cached permanently.

## Uninstall and complete cleanup

There is no top-level `devbox uninstall` subcommand in v0.3.0; `db mutagen uninstall`
only removes the local daemon service. For a disposable profile, first
stop it and prove that the private Mutagen selector is empty. Only then remove the exact
profile roots and profile state; inspect every path before running the destructive lines:

```sh
PROFILE=roam
LOCAL_ROOT="$HOME/scratch/roam"
REMOTE_ROOT=/home/alice/roam

# Stop and verify ownership-scoped cleanup.
devbox disable --profile "$PROFILE" --json
MUTAGEN_DATA_DIRECTORY="${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen" \
  "$HOME/.local/state/devbox/tools/mutagen-0.18.1/mutagen" sync list

# Only if these exact roots are disposable and the list above has no Devbox sessions.
rm -rf -- "$LOCAL_ROOT"
rm -rf -- "$HOME/.local/state/devbox/profiles/$PROFILE" \
         "$HOME/.local/state/devbox/profiles/$PROFILE.json"
ssh alice@203.0.113.10 'rm -rf -- \
  /home/alice/roam \
  /home/alice/.local/state/devbox/roam'

# Remove any old Devbox-managed block from ~/.zprofile, then remove the installed CLI.
rm -f -- "$HOME/.local/bin/devbox"
```

Do not remove the whole `$HOME/.local/state/devbox` tree if another profile uses it.
Remove the dedicated Mutagen binary only if it is not used by another workflow. Keep
`docs/devbox-recovery.md` beside this guide for network loss, conflicts, host-key drift,
failed jobs, and VM reboot recovery.
