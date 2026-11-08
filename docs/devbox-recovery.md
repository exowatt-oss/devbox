# Devbox recovery runbook

This is the operator runbook for the checked-in Devbox runtime. It favors preserving
both sides over making an apparently healthy state by choosing a winner. Do not delete,
reset, or copy over a workspace to make a status line green.

The v0.3.0 CLI exposes profile creation, preflight, lifecycle, execution, job, port,
Phase 1 whole-profile Git handoff, and hub-and-spoke Mutagen service operations. Doctor,
repair, conflict, auth, and support remain blocked contracts. A blocked command is not a
recovery procedure.

Devbox local recovery state is under `${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}`
with `profiles/`, `generations/`, and `mutagen/` subdirectories. The remote state root
is `$HOME/.local/state/devbox/<profile>`. Mutagen v0.18.1 is an external,
managed binary and is not bundled. Devbox resolves it automatically, or accepts the
optional `DEVBOX_MUTAGEN_BINARY` absolute-path override, and uses the app-private
`MUTAGEN_DATA_DIRECTORY=${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen`
namespace. For `db init`, the default profile ID is the basename of `--local-root`; for
`db connect`, it is the basename of `--remote-root`. Both are sanitized to
`[A-Za-z0-9._-]` (other characters become `-`), capped at 64 characters, must start
alphanumeric, and fall back to `devbox` otherwise. A local hub (`hub-is-local`) is
refused before any bootstrap step with an error envelope code `operation_conflict` and
exit `6`; a spoke root (`hub-root-is-a-spoke`) is refused in the `remote` step for both
`init` and `connect`, producing `result.status: "failed"` and exit `1`. `db mutagen
setup` registers the spoke only when a profile is selected and `--no-remote` is not
passed. `db mutagen logs --lines <n>` requires a positive integer (default `80`, minimum
`1`; `0` is rejected with usage exit `2`). Install the public release without authentication as described in [INSTALL.md](INSTALL.md).

Verify the release checksum before using a manually downloaded binary.

## Before any incident action

Installing the binary is the only opt-in. The CLI needs zero required environment
variables; it resolves its verified Mutagen binary and uses the default state paths.
If the CLI says the runtime is unavailable, retry `devbox pair`; there
is no `devbox open` command in 0.3.0. Identify the profile ID from local Devbox state.
Start with a read-only status
check:

```bash
devbox status --profile <profile-id> --json
```

Record the `state`, `operationId`, `generationId`, `journalRestored`, `sync.state`,
`sync.capability`, `sync.watchMode`, `sync.conflictCount`, `sync.degradation`, and the
sync observation fields when they are present. The human formatter intentionally shows
only a compact subset; use JSON for incident evidence.

When the Devbox status is not enough, read the app-private Mutagen state directly. This is
read-only and must use Devbox's private data directory, never the global Mutagen namespace:

```bash
MUTAGEN_DATA_DIRECTORY="${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen" \
  "$HOME/.local/opt/mutagen-0.18.1/extracted/mutagen" \
  sync list --label-selector devbox-profile=<profile-id> --template '{{json .}}'
```

The human `sync list -l` output truncates every conflict and problem list to ten entries
and prints `...+N more...`; only the JSON template exposes the complete `conflicts`,
`excludedConflicts`, `alpha.transitionProblems`, `beta.transitionProblems`,
`alpha.scanProblems`, and `beta.scanProblems` fields, plus the session configuration
(`maxEntryCount`, `maxStagingFileSize`, `ignore.paths`).

If a command returns `offline`, retry `devbox pair` after SSH reachability is
restored, then repeat `status`. If it returns `ssh_identity_mismatch`, do not retry
mutating commands: re-verify the exact SSH endpoint and host key in Devbox first.

## Recovery rules

- Keep the current authority side. Network loss and laptop sleep do not expire an
  authority epoch.
- Do not start a second Devbox instance, a second sync session, or an unlabelled
  Mutagen session.
- Do not run raw `rsync --delete`, reset Git, remove `.git`, remove session files, or
  edit Devbox witness/journal files by hand.
- Do not install or invoke an unapproved `mutagen` binary as a workaround. Mutagen is
  external and non-bundled; use the approved v0.18.1 binary through
  the optional `DEVBOX_MUTAGEN_BINARY` override and the app-private data directory.
- When a recovery command is retried, use the same profile and job IDs unless this
  runbook explicitly says to choose a new job ID. The job registry is designed to
  attach to an already-created job rather than duplicate it.
- Devbox shell cleanup is ownership-scoped. New shells use a private profile tmux
  socket named `devbox-${sha256(profileId UTF-8).hex.slice(0,12)}`; do not use
  `kill-server`, a wildcard target, or a global tmux cleanup command.

### `journal_corrupt` recovery

If `devbox status` or `devbox pair` reports `journal_corrupt`, do not hand-edit or
delete either journal file. Quarantine `operations.jsonl` and its `.checkpoint`
sibling (currently `operations.jsonl.checkpoint`) by moving them, never deleting
them, so the profile can be replayed from a clean journal:

```bash
STATE="${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}"
PROFILE="<profile-id>"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
QUARANTINE="$STATE/quarantine/$STAMP"
mkdir -p "$QUARANTINE"
mv "$STATE/profiles/$PROFILE/operations.jsonl" "$QUARANTINE/"
if [ -e "$STATE/profiles/$PROFILE/operations.jsonl.checkpoint" ]; then
  mv "$STATE/profiles/$PROFILE/operations.jsonl.checkpoint" "$QUARANTINE/"
fi
devbox status --profile "$PROFILE" --json
devbox pair --profile "$PROFILE" --json
```

Leave `$STATE/profiles/<id>.json`, `$STATE/profiles/<id>/known_hosts`, and
`$STATE/mutagen` alone. Existing sessions are re-adopted by `sessionId`; do not
create replacement sessions during recovery. v0.2.12 adds the cross-process
journal lock, so new overlapping-writer collisions do not occur.

## Terminal session recovery

`devbox shell ls --profile <profile-id> --json` probes the private profile socket first
and the legacy default socket second. It reports only canonical
`devbox-<profile>-<id>[-<name>]` sessions. A session made by v0.1.5 with the validated
name-only shape `devbox-<profile>-<sanitized-name>` is intentionally absent from `ls`
but remains a targeted `devbox shell rm <name>` cleanup candidate. If both sockets
contain the same canonical name, `rm --all` attempts each socket separately.

`devbox shell rm --all --profile <profile-id> --json` is the safe repeatable cleanup
boundary for these resources. A session disappearing between discovery and its kill is
success; rerun the command if the remote connection failed. Never replace this with a
server-wide kill or wildcard deletion, and never remove a foreign prefix or malformed
session.

### Shell connection dropped

When an attached shell reports an SSH transport loss (exit 255), stay at the in-place
prompt and let Devbox retry the same tmux session:

```text
devbox: connection lost (ssh exit 255) — reconnecting to shell #7 (betterssh) on alice@203.0.113.10 in 1s… [Enter] now · [q] quit
```

If you quit that loop or the pane is no longer attached, recover in this order:

1. Reattach the session last used by this terminal:
   `db shell resume --profile <profile-id>`.
2. List the profile's sessions and attach one explicitly (no terminal host required):
   `db shell ls --profile <profile-id>`, then
   `db shell <id-or-name> --profile <profile-id>`.
3. If you use the optional Forca terminal-host integration, reopen every detached session
   as a titled tab: `db shell reconnect --all` (add `--profile <profile-id>` to limit it).

`--dry-run` on optional `reconnect --all` prints its plan without opening tabs. Opening tabs
requires the `forca` CLI and a reachable Forca runtime; use the manual commands in its
error if either is unavailable. Pass `--no-reconnect` or set
`DEVBOX_SHELL_RECONNECT=0` only when you intentionally want the old return-to-prompt
behavior.

## Failure modes

### 1. Mutagen daemon or sync daemon is dead

**Why it happens:** Without a keepalive service, `pair` can start Devbox's
app-private daemon on demand, but reboot or logout kills it. Status probes deliberately
do not start it (`MUTAGEN_DISABLE_AUTOSTART=1` is used while listing sessions).
`shell`, `run`, `jobs`, and `ports` do not start it. An `on-demand` origin is therefore
not reboot-safe. The hub never runs a daemon; only each local spoke does.

**Primary fix (0.3.0):** let Devbox install and own the service. It is idempotent and
hands over from an on-demand daemon without killing a running sync. With a selected
profile and without `--no-remote`, setup registers/touches the spoke and hub records;
otherwise remote registry work is skipped:

```bash
db mutagen setup --profile <profile-id> --json
db mutagen status --profile <profile-id> --json
db mutagen start --json
db mutagen logs --lines 80 --json
```

Use `status` first to inspect `service.running`, `daemon.running`, daemon `origin`,
`lastCycleAt`, session problems/conflicts, topology, and hub registration. With a
selected profile, status attempts to update the remote spoke `lastSeenAt` when that
spoke is registered and the hub is reachable; add `--no-remote` to skip that registry
touch. An installed service with no running daemon, or any topology violation, exits `1`. `start` uses the service manager when installed and otherwise
starts the private daemon directly. `stop` and `restart` gracefully run `mutagen daemon stop` before the service manager action; the generated wrapper forwards SIGTERM to its child, so an installed restart should recover within about 45 seconds. Do not use a global `mutagen daemon` namespace.

**Legacy manual recipe (pre-0.3.0):** `db mutagen setup` replaces this hand-rolled
LaunchAgent and flags its old `~/.local/bin/devbox-mutagen-daemon` wrapper as unused.
Keep this only to recover a machine that cannot yet run Devbox 0.3.0. The wrapper must use `MUTAGEN_DATA_DIRECTORY=${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen`, never
kill a running sync, retry a child that exits within 5 seconds every 60 seconds (lock
handover), and restart a longer-lived child after 15 seconds. The current generated
wrapper (installed by `db mutagen setup`) additionally waits 300 seconds when no managed
binary is available; the legacy snippet below does not:

```sh
#!/bin/sh
set -u
export MUTAGEN_DATA_DIRECTORY="${MUTAGEN_DATA_DIRECTORY:-${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}/mutagen}"
bin=$(ls -d "$HOME"/.local/opt/mutagen-*/extracted/mutagen 2>/dev/null | sort -V | tail -n 1)
while :; do
  started=$(date +%s); "$bin" daemon run; rc=$?
  elapsed=$(( $(date +%s) - started ))
  [ "$elapsed" -lt 5 ] && sleep 60 || sleep 15
done
```

Save it mode `0755` as `~/.local/bin/devbox-mutagen-daemon`. Install
`~/Library/LaunchAgents/org.devbox.mutagen-daemon.plist` with the service
label, the wrapper as `ProgramArguments`, `MUTAGEN_DATA_DIRECTORY` and a system PATH,
`RunAtLoad=true`, `KeepAlive=true`, and one log path for stdout/stderr:

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>org.devbox.mutagen-daemon</string>
  <key>ProgramArguments</key><array><string>/Users/alice/.local/bin/devbox-mutagen-daemon</string></array>
  <key>EnvironmentVariables</key><dict><key>MUTAGEN_DATA_DIRECTORY</key><string>/Users/alice/.local/state/devbox/mutagen</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/alice/Library/Logs/devbox-mutagen-daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/alice/Library/Logs/devbox-mutagen-daemon.log</string>
</dict></plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.devbox.mutagen-daemon.plist
launchctl print gui/$(id -u)/org.devbox.mutagen-daemon | grep -E 'state|pid'
```

This legacy path is macOS-only and is not the global daemon. Delete the wrapper and
plist after `db mutagen setup` succeeds. If the service still fails after setup, keep
the profile disabled, preserve JSON status/logs, and do not substitute a manually
started global daemon.

### 2. Devbox was killed during a generation or consistent run

The generation manager recovers its app-owned generation root before creating the next
generation. Unusable generation directories and incomplete staging directories are
removed by that recovery path; a verified generation is retained. The current CLI has
no standalone `generation verify` or `generation recover` command, so trigger recovery
through the next consistent run.

**Diagnose:**

```bash
devbox status --profile <profile-id> --json
devbox jobs status --profile <profile-id> --job-id <job-id> --json
```

`journalRestored: true` means the runtime replayed at least one journal operation. It
is not proof that the interrupted operation committed. A job status of `running`,
`completed`, `failed`, or `cancelled` is authoritative for that remote job.

**Recover:** first resume the profile if necessary:

```bash
devbox pair --profile <profile-id> --json
```

Then retry the workload with `--consistent`:

```bash
devbox run --profile <profile-id> --id <job-id> --cwd <remote-path> \
  --consistent -- <argv...>
```

If the remote job was created before the app died, the same job ID attaches to the
existing registry record and does not launch a duplicate. If no record exists, the
same invocation creates the job after a fresh isolated generation is prepared. If the
job already exists with a terminal failure, choose a new job ID for a deliberate retry;
reusing it attaches to the failed record rather than rerunning it.

If generation creation fails again, preserve the status and error. There is no current
operator command to inspect or repair a failed generation, and the blocked `repair`
command must not be treated as one.

### Residual Mutagen daemon or agent cleanup

`devbox disable` is the supported cleanup boundary. It re-queries the app-private
Mutagen namespace for the complete Devbox label set (including
`devbox-profile=<profile-id>`), flushes best-effort, terminates every session carrying
that complete label set, verifies that the selector is empty, and stops the app-private
daemon. It then makes a conservative
best-effort pass over the remote process table for `mutagen-agent` processes whose
arguments contain this profile's Devbox state root or configured remote workspace.
Unrelated user processes are never targeted.

If a disable command fails, preserve its JSON error and do not use a global `pkill`,
`mutagen daemon stop`, or a broad process kill. Re-run `devbox status` and inspect only
the profile-scoped selector; escalate with the surviving session identifiers and
profile state path. After a disposable test or pilot, verify the selector is empty,
then remove only the throwaway local/remote workspace and profile state directories.

### 3. Network partition or SSH reconnect

The authority remains where it was. A disconnected laptop does not authorize a
handoff, and a remote detached job may continue while the control connection is down.
Do not use timestamps to infer that a peer has taken ownership.

**Diagnose:**

```bash
devbox status --profile <profile-id> --json
devbox jobs status --profile <profile-id> --job-id <job-id> --json
devbox jobs log --profile <profile-id> --job-id <job-id> --json
```

A sync observation with `freshness: "stale"` or `"unknown"`, a lifecycle `offline`
error, or a disconnected terminal indicates that the control/sync path is not current.
A remote job's status and bounded log tail are separate from the mirror's freshness.

**Recover:** when SSH and the Devbox runtime are reachable again:

```bash
devbox pair --profile <profile-id> --json
devbox status --profile <profile-id> --json
```

The supervisor reconnects or recreates only app-owned sessions and performs a fresh
status scan. Do not resume an authority transition from the middle based on the old
wall-clock time. If the endpoint or host key changed, stop at
`ssh_identity_mismatch` and re-verify the target before retrying.

If local edits were made while the mirror was offline, leave both versions in place
until the conflict path is available. The current CLI cannot list or resolve those
conflicts; the directional fallback must not be presented as a safe merge.

### 4. Conflicting writers

A conflict is a safety stop, not a reason to choose the newest timestamp. This includes
managed writers racing during a transition and ordinary same-path file divergence.

**Diagnose:**

```bash
devbox status --profile <profile-id> --json
```

Look for `sync.conflictCount` greater than zero, a session phase of `conflicted`, an
`operation_conflict` error, or an authority error indicating that a managed writer did
not quiesce.

**Stabilize:** stop new Devbox-owned sync activity without deleting workspace data:

```bash
devbox disable --profile <profile-id> --json
```

If disable reports an active-session or safety conflict, keep both roots untouched and
preserve the JSON status/error. Do not run raw rsync, remove a conflict marker, or
manually replace one side.

**Current limitation:**

```bash
devbox conflicts --profile <profile-id> --json
```

is a real command spec, but it is blocked before runtime dispatch because the current
IPC has no conflict-list channel. There is consequently no supported CLI command to
create the required pre-resolution backup, show both hashes, or resolve a conflict.
The operator must leave the profile disabled and escalate with both sides preserved.
Do not report the incident as recovered until an implemented conflict-resolution
surface has produced a backup and an explicit winner.

### 5. Drift in profile, toolchain, host, or materialized state

Status and sync health do not prove declarative parity. A profile can be valid while a
host tool, generated file, path map, or endpoint has drifted.

**Diagnose:**

```bash
devbox status --profile <profile-id> --json
```

Record the status and any `profile_malformed`, `profile_version_unsupported`,
`toolchain_invalid`, `toolchain_digest_invalid`, `ssh_identity_mismatch`, or
`operation_conflict` error. Do not edit a malformed profile in place or infer that a
successful terminal launch repaired it.

The intended diagnostic and repair commands are present only as blocked contracts:

```bash
devbox doctor --profile <profile-id> --json
devbox repair --profile <profile-id> --json
```

Both fail before contacting the runtime in the current implementation. There is no
supported operator command to enumerate drift, render a repair plan, or apply an
idempotent repair. Keep the profile disabled with `devbox disable` if it is still
running, preserve the error/status evidence, and correct the underlying profile or
host only through an approved implementation of that missing surface.

### 6. Stale authority epoch or interrupted handoff

Phase 1 uses a monotonic whole-profile epoch and a checksummed peer marker. A handoff
must flush, verify freshness/conflicts, pause, refresh the passive origin, adopt the
published branch, park/unpark metadata atomically, verify topology, commit the epoch,
and resume. An arbitrary same-user shell is not fenced by the epoch; drift is detected
and blocks completion.

**Diagnose:**

```bash
devbox status --profile <profile-id> --json
devbox handoff --profile <profile-id> --to remote --json
```

Status exposes `gitRoaming.owner`, `epoch`, `epochSequence`, `transition`,
`witnesses`, topology, repository/dirty/unpublished counts, and passive refresh. A
`candidate`, `quiesced`, or `reconciling` transition is a durable candidate, not proof
that the target owns Git. A `committed` transition means the target topology and epoch
are authoritative even if the process died before resume.

**Recover:** do not delete, copy, reset, or manually rename either `.git` store. Run
`status` once to replay topology recovery, then repeat the same `handoff --to` command.
Before the epoch commit recovery restores the old owner; after the commit it completes
the candidate owner. The operation is safe to retry and never terminates the sync daemon
as a takeover mechanism. A missing or checksum-tampered witness fails closed; preserve
the JSON error and escalate rather than editing marker files.

Phase 2 intentionally remains out of this runbook: per-repository authority, peer
object/bundle fetch, dirty handoff, and conflict-resolution tooling are not implemented.

### 7. Pair initialization interrupted while parking metadata

Pairing is allowed to continue with dirty, unpublished, origin-less, or linked-worktree
repositories; those are handoff constraints. Pair still blocks on a missing remote root,
a hard path-safety collision, or a park/unpark failure. During pair initialization Devbox
writes a candidate transition before changing passive metadata. If the process is killed
or an error occurs after one or more `.git` directories are parked, the next `pair` or
`status` replays the candidate recovery and restores the old active/parked-consistent
topology. The recovery path never deletes Git metadata and does not require a manual
parking helper.

**Diagnose and recover:**

```bash
devbox status --profile <profile-id> --json
devbox pair --profile <profile-id> --json
```

Confirm `gitRoaming.transition` returns to `idle`, the old authority has active `.git`
metadata, and the passive side has `.git.devbox-parked`. If a named warning is present,
it is a pair-time refresh warning; origin-less repositories and fetch stderr remain
visible in `gitRoaming.warnings` and must be resolved before handoff. Do not manually
rename, delete, or copy `.git` and `.git.devbox-parked` directories.

### 8. Failed or interrupted detached job

The remote job registry is keyed by job ID and a complete specification hash. This is
what makes retry after an app/relay crash an attach operation instead of a duplicate
side effect.

**Diagnose:**

```bash
devbox jobs status --profile <profile-id> --job-id <job-id> --json
devbox jobs log --profile <profile-id> --job-id <job-id> \
  --offset 0 --limit 65536 --json
```

Use the returned `status` and `exitCode` when present. The log tail is sensitive
workload data; the normal human command can print it, but JSON deliberately reports
only whether text is available.

**Recover:** if the job is still running and must stop, cancel it:

```bash
devbox jobs cancel --profile <profile-id> --job-id <job-id> --json
```

After a terminal `failed` or `cancelled` result, retry with a **new** job ID and the
same verified command specification:

```bash
devbox run --profile <profile-id> --id <new-job-id> --cwd <remote-path> \
  --consistent -- <argv...>
```

If the app died after remote create/start but before receiving the acknowledgement,
retrying the original job ID is safe and attaches to the existing registry record. Do
not reuse a failed ID when the intent is to execute again: the current handler sees the
existing record and returns it.

### 9. Credential or OAuth expiry

The credential broker deliberately keeps auth state out of the profile and generic sync.
It can classify a capability as forwarded-only, machine-enrolled, OAuth-per-host, or
unavailable, and can mark a capability `required`, `expired`, `revoked`, or `blocked`.
An endpoint or host-key change blocks delivery even if the old token is otherwise
usable.

**Current limitation:** the current Devbox IPC and CLI expose no auth-health, capability
probe, enrollment, OAuth authorization, or machine-revocation operation. A lifecycle
status response is not an auth-health report. There is no truthful Devbox command that
can diagnose which provider capability expired or repair it.

If a Devbox operation returns `auth_required`, `bridge_denied`, or
`bridge_scope_denied`, stop retrying that operation and do not copy an auth cache or
secret into the workspace. Re-verify the exact SSH target if the error names a changed
endpoint or host key. Use the existing provider OAuth flow for the affected provider
when it is available, then retry only the dependent operation. Launching Phi itself
requires the existing bridge identifiers:

```bash
devbox phi --profile <profile-id> --path <local-path> \
  --session-id <session-id> --relay-epoch <relay-epoch> --json
```

That command launches Phi; it does not enroll a credential or refresh a provider
secret. If no existing provider flow is available, leave the capability unavailable,
keep ordinary sync/terminal work separate, and escalate. Do not claim auth recovery
from a green sync status.

### 10. Large files never converge (staging file-size cap loop)

Sessions created by Devbox `<= 0.2.16` carry `--max-staging-file-size=100 MB`. Mutagen
(v0.18.1, `staging/store/store.go`, `Storage.Write`) does not skip a file over the cap: it
streams the file, aborts the staging write at the cap, fails the transition, and retries
the full transfer on the next cycle. Every over-cap file is re-sent forever and every
cycle waits for them, so small changes take minutes instead of seconds.

**Diagnose:** `sync list -l` shows `Status: Staging files on alpha` (or `beta`) cycling
over the same file count and gigabytes; the JSON shows `maxStagingFileSize: 100000000`
and transition problems of the form
`unable to create file: unable to set staged file permissions: ... chmod .../.mutagen-temporary-staging-<session>-alpha/<xx>/<digest>: no such file or directory`.
Conflict and problem counts are otherwise normal. Observed 2026-09-23 on the `project`
profile: 38 files, ~15 GB, re-sent every cycle, cycle time ~10 minutes.

**Recover:** upgrade to Devbox `>= 0.2.17` (no default cap), then recreate the profile's
sessions: `devbox disable --profile <profile-id> --json`, then
`devbox pair --profile <profile-id> --json`. Verify with the JSON template that
`maxStagingFileSize` is absent on every session. Recreated sessions have no ancestor, so
their first cycle reports every file that differs on both sides as a conflict and never
infers a deletion; identical files are not transferred again. Keep large build or data
artifacts out of a sync root with ignore patterns; do not reintroduce a size cap.

## What is and is not recovered by the current CLI

| Incident                    | Safe current action                                             | Current result                                                                      |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mutagen/daemon interruption | `pair`, then `status`                                           | Reconnect/recreate only when the approved backend is configured; no install command |
| Daemon dead after reboot    | `db mutagen setup`, then `db mutagen status`               | Service owns the daemon; use `start`/`logs` for diagnosis                                  |
| Staging cap loop (<= 0.2.16) | Upgrade to `>= 0.2.17`, `disable`, then `pair`                 | Sessions are recreated without a cap; no in-place session reconfiguration           |
| App kill during generation  | `pair`, then the same consistent run/job ID                     | Generation recovery is triggered by the next run; no standalone verify command      |
| Network partition           | Wait for reachability, `pair`, then `status`                    | Authority is preserved; mirror freshness must be rescanned                          |
| Spoke ↔ spoke / chained sync attempted | Refused by `db init`/`db connect` (`hub-is-local` before any step; `hub-root-is-a-spoke` in `remote`); use the hub | Spokes sync only local root → the remote hub; no local ↔ local path is valid |
| Working-file conflict       | `status`, then `disable`                                        | New writes stop; no CLI conflict backup/list/resolve                                |
| Declarative or host drift   | `status`, then `disable` if needed                              | No CLI doctor/repair surface                                                        |
| Stale authority epoch       | `status`, `disable`; preserve checkpoints                       | No CLI handoff or witness recovery surface                                          |
| Failed detached job         | `jobs status`, `jobs log`, optional `jobs cancel`, new-ID `run` | Status/log/cancel and deduplicated launch are available                             |
| Auth expiry                 | Preserve state; use the existing provider flow if available     | No Devbox auth-health or enrollment CLI surface                                     |

The lack of a command is intentional documentation of the implementation boundary, not
permission to improvise a destructive substitute. The profile should remain disabled
until the missing recovery surface is implemented and validated against the plan's
fault-injection acceptance criterion.
