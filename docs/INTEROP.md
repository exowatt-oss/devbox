# Devbox interop contract

This is the public contract for a host application that discovers and attaches to
persistent Devbox shells on a remote host. Terminal host integrations depend on the
rules in this file; they are intentionally narrower than Devbox's internal implementation.

## Scope and stability

A host may rely on the documented CLI commands, successful JSON shapes, tmux session
name construction and parsing rules, tmux defaults, remote-cwd validation, credential
env staging boundary, bridge-capability boundary, and tmux prerequisite errors below.
Devbox will preserve those surfaces as an interop contract. Additive JSON fields are
backward-compatible; a host must ignore fields it does not use. The success envelope
uses CLI schema version `1` (`src/cli/format.ts:6-15`, `src/cli/format.ts:29-39`).

Anything not specified here is internal and may change without notice. In particular,
do not import or scrape Devbox's profile files, state directories, operation keys,
private TypeScript helpers, or tmux output to create a second protocol. The CLI is the
boundary: use the commands and fields in this document. The shell implementation
currently exports helper functions for its own tests (`src/cli/shell.ts:30-47`), but
those exports are not a host SDK.

## Session names and ownership

Devbox's tmux session name is exactly:

```text
devbox-<sanitized-profile-id>-<id>[-<sanitized-name>]
```

`profile-id` and the optional friendly `name` use the same sanitization pipeline, in
this order (`src/cli/shell-sessions.ts:46-53`, `src/cli/shell-sessions.ts:55-63`):

1. Trim leading and trailing whitespace.
2. Replace every run matching `[^A-Za-z0-9._-]+` with one `-`.
3. Strip leading and trailing `-`.
4. Truncate to 96 characters.
5. Reject the component if it is empty after those steps.

The parser first removes the profile-specific prefix and applies this exact suffix
regex (`src/cli/shell-sessions.ts:1-3`, `src/cli/shell-sessions.ts:65-78`):

```regex
^([1-9][0-9]*)(?:-([A-Za-z0-9._-]+))?$
```

The regex is necessary but not sufficient: parsing also rebuilds the canonical name
and rejects it unless the rebuilt string is identical. That canonical check enforces
the 96-character limit and the sanitization boundary rules. A name without a friendly
suffix is valid; the id is a positive safe integer (`src/cli/shell-sessions.ts:59-63`).

New ids are allocated as the lowest unused positive integer (`src/cli/shell-sessions.ts:91-97`).
Removing id `2` therefore makes id `2` available again. A host that caches an id can
attach to a different, newly created session after removal; cache the canonical
`sessionName` only for as long as the corresponding session is known to exist, and
re-discover before reuse.

Devbox parses only names with the selected profile's `devbox-<sanitized-profile-id>-`
prefix. Foreign-prefixed or malformed tmux sessions are ignored by discovery, not
reported as Devbox sessions (`src/cli/shell-sessions.ts:65-78`, `src/cli/shell-lifecycle.ts`).
**A host MUST NOT invent a second naming scheme.** If it does, `devbox shell ls` and
the host will disagree about what exists.

### Profile tmux sockets and legacy transition

New Devbox sessions live on a private tmux server whose socket name is deterministic
but does not expose the profile id:

```text
devbox-<sha256(profile-id UTF-8).hex.slice(0,12)>
```

Devbox starts that server with `tmux -f /dev/null -L <socket>`. It probes the private
socket first and the user's legacy default socket second. Canonical sessions found on
either socket keep the same list/attach JSON identity; a private duplicate wins for
attachment, while cleanup addresses each socket independently. Hosts must not infer a
socket from a session name or attach through the default socket for a new session.

The v0.1.5 name-only shape `devbox-<sanitized-profile-id>-<sanitized-name>` is
recognized only as a narrowly validated cleanup candidate. It is never returned by
canonical `shell ls`, never allocated for `shell new`, and never used for bare attach.
`rm <id-or-name>` accepts its friendly name or complete tmux name. Foreign prefixes,
malformed names, and ambiguous numeric-only legacy names are never cleanup targets.

## Creation and attachment command

The remote attach script first sets `set -e` and assigns the validated session and cwd.
For a new private server it creates a temporary bootstrap session, configures the server,
creates the requested session, removes the bootstrap, and finally runs
`exec tmux -f /dev/null -L "$socket" attach-session -t "$session"`
(`src/cli/shell.ts`, `src/cli/shell-tmux.ts`). The session name is therefore the
identity used both for creation and reattachment. Existing canonical sessions on the
default socket use plain `tmux` so Devbox does not rewrite a user's shared tmux server.

Every private-server creation path emits these option lines, in this exact order,
after the bootstrap has ensured the server exists and before the requested session is
created:

```sh
tmux -f /dev/null -L "$socket" set-option -g extended-keys on 2>/dev/null || tmux -f /dev/null -L "$socket" set-option -s extended-keys on
tmux -f /dev/null -L "$socket" set-option -g mouse on 2>/dev/null || tmux -f /dev/null -L "$socket" set-option -s mouse on
tmux -f /dev/null -L "$socket" set-option -g history-limit 100000
tmux -f /dev/null -L "$socket" set-option -g set-clipboard on
tmux -f /dev/null -L "$socket" set-option -su terminal-features 2>/dev/null || true
tmux -f /dev/null -L "$socket" set-option -sa terminal-features 'xterm*:clipboard:ccolour:cstyle:focus:title' 2>/dev/null || true
tmux -f /dev/null -L "$socket" set-option -g set-titles on
tmux -f /dev/null -L "$socket" set-option -g set-titles-string '#{pane_title}'
```

`extended-keys` is on, with no `extended-keys-format` override. Mouse mode and
100,000 lines of history are enabled. `terminal-features` is restored to tmux's stock
array and the `xterm*` entry is pinned explicitly (a plain `set terminal-features X`
replaces the whole array; Devbox <= 0.6.8 left a single no-op `clipboard` entry that
disabled title and OSC 52 clipboard support for `TERM=xterm*` clients). With the `title`
feature, `set-titles on`, and `set-titles-string '#{pane_title}'`, tmux forwards the
active pane's title (OSC 0/2 from a remote program, for example phi's `π …` status
titles) to the attached client verbatim, so the local terminal host sees it. tmux
emits it as `ESC ] 0 ; <pane title> BEL` (the `title` feature's `tsl`), which sets the
window title like OSC 2. A plain shell forwards its default pane title (the remote
hostname). `allow-passthrough` is not enabled: arbitrary in-pane OSC still does not
reach the local terminal. These options are server-global on the private socket, so the
first attach by a 0.6.9 CLI upgrades every session on that profile; a client attached
earlier gets the title capability on its next attach. The private server uses tmux 3.4-compatible
stock-style root wheel/drag guards: an active pane/application mouse mode forwards
`send-keys -M`; otherwise wheel/drag enters copy mode. Copy-mode wheel bindings select
the pane under the pointer before scrolling, and drag release runs
`copy-selection-and-cancel`. Normal keyboard bindings and middle-click paste are not
overridden. The credential preparation path uses the same private socket and bootstrap
ordering. Cleanup traps prevent a failed creation from leaving a bootstrap session.

The plugin-free status bar uses built-in formats only: `DEVBOX`, host and session on
the left; the active window in the window list; pane command, a tail-truncated current
working directory, `COPY`/`PREFIX` state, and `%H:%M` on the right. No user config,
plugin, external executable, or default shared-server option is required.

## Terminal host integration marker (OSC 9998)

The local Devbox CLI emits an optional terminal host integration marker around an
interactive `shell` attach. This is a local-only signal: it is written to the local
CLI's stdout and is never sent to the remote host. The attach marker is written
immediately before the interactive SSH child is spawned, after the target session has
been resolved or its identity allocated. The detach marker is written immediately after
the child exits, including signal and error paths, on a best-effort basis. On a reconnect
attempt, that detach marker is emitted when the SSH child exits, and a fresh attach marker
is emitted before each retry. Hosts MUST tolerate detach → attach cycles for the same
`sessionName`.

Since 0.6.9 the sequence around a dropped connection (ssh exit 255) that the CLI retries is:

```text
attach → detach{reason:"connection-lost",exitCode:255} → state{state:"reconnecting",attempt:1,retryInMs:1000}
       → attach → … (another detach/state pair per failed retry)
       → detach{reason:"exit",exitCode:0}            (later clean exit or tmux detach)
       → detach{reason:"exit",exitCode:255}          (instead, if the user abandons the wait with q/Esc/Ctrl-C)
```

Markers are emitted only when the local stdout is a TTY and
`DEVBOX_TERMINAL_MARKERS` is not exactly `0`. They are never emitted for `--json`,
non-TTY output, `shell ls`, removal commands, or other non-attach paths. The wire frame
is one UTF-8 line terminated by BEL:

```text
ESC ] 9998 ; devbox-terminal ; <JSON> BEL
```

In escaped form, the frame is:

```text
"\x1b]9998;devbox-terminal;" + JSON.stringify(payload) + "\x07"
```

The payload is serialized with `JSON.stringify` without an additional escaping layer.
It must contain no control characters, remain one line, and be at most 2048 UTF-8
bytes. If validation fails, the local CLI skips that marker rather than blocking shell
attachment. A host should ignore unknown OSC sequences; terminals that do not consume
this marker safely display no marker text.

An attach payload has this key order and shape (optional fields are omitted):

```json
{
  "v": 1,
  "event": "attach",
  "profileId": "roam",
  "sessionId": 2,
  "sessionName": "devbox-roam-2-emufix",
  "friendlyName": "emufix",
  "host": "203.0.113.10",
  "port": 22,
  "username": "alice",
  "remoteCwd": "/home/alice/project",
  "program": "phi",
  "tmuxSocket": "devbox-01ff033d051e",
  "cliVersion": "0.2.16"
}
```

The detach payload (0.6.9; `reason` and `exitCode` are absent from CLIs <= 0.6.8, and
`exitCode` is absent when the SSH child could not be spawned) is:

```json
{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-2-emufix","reason":"connection-lost","exitCode":255}
```

The reconnect state payload (0.6.9), written as each reconnect wait starts:

```json
{"v":1,"event":"state","profileId":"roam","sessionName":"devbox-roam-2-emufix","state":"reconnecting","attempt":1,"retryInMs":1000}
```

Field rules are strict. `v` is `1`, and `event` is `attach`, `detach`, or (0.6.9)
`state`.
`profileId` matches `^[a-z0-9][a-z0-9-]{0,63}$`. `sessionName` is the canonical
tmux name `devbox-<profile>-<id>[-<friendly>]` and is at most 128 characters;
`sessionId` is a positive safe integer. `friendlyName`, when present, is at most 64
characters and is the sanitized session suffix. `host` is the configured SSH IP or
hostname and is at most 253 characters; `port` is 1–65535; and `username` is at most
64 characters. `remoteCwd`, when known, is an absolute path at most 512 characters.
For the optional phi integration, `program` is `phi` when an existing session's current pane command is exactly `phi`,
and `shell` otherwise (new sessions are `shell`). `tmuxSocket` is the private socket
name when one is used and is omitted for legacy default-socket sessions. `cliVersion`
is the local CLI version string. `sessionId`, `friendlyName`, `remoteCwd`,
`tmuxSocket`, and `cliVersion` appear only in attach payloads as applicable.

Detach `reason` says why the attach ended: `exit` when the SSH/tmux client exited 0
(including a tmux detach and a session whose last shell exited) or the user abandoned a
reconnect wait; `connection-lost` when SSH exited 255 and the CLI is about to retry;
`error` for every other exit code, a spawn failure, and an exit 255 the CLI will not
retry (`--no-reconnect`, `DEVBOX_SHELL_RECONNECT=0`, or non-TTY stdin/stderr). `exitCode`
is the SSH child's integer exit code (the CLI's own exit code for an abandoned wait).
State `state` is only `reconnecting`; `attempt` is the 1-based reconnect attempt about to
run (the original attach is not counted) and `retryInMs` the scheduled wait in integer
milliseconds (Enter retries sooner). Both are optional for hosts.

### Host handling

A host may use the attach event to create a tab or badge and the detach event to clear
it. Hosts must ignore unknown events, unknown keys, and unknown values; that is what keeps
0.6.9's additions invisible to older hosts. Older Forca builds before native devbox tabs return null for any event other than
`attach`/`detach` and copies only its known keys, so it drops `state` frames (the bytes
are still consumed) and treats a 0.6.9 detach exactly like a 0.6.8 one; a second detach
for a session it already cleared is a no-op there. Forca with native devbox tabs maps
`detach{connection-lost}` and `state{reconnecting}` to a reconnecting tab,
`detach{exit|error}` to a plain terminal, and a reason-less detach (CLI <= 0.6.8) to a
provisional state it resolves with a process check. The devbox test
`src/cli/shell-terminal-marker-forca.test.ts` parses every marker this CLI emits with
copies of both Forca grammars. Hosts must use the canonical `sessionName` as the stable identity and must not
infer a socket from that name. Marker delivery is advisory; a host must continue to
work when markers are disabled, unavailable, or skipped because a field cannot be
represented safely.

An interactive attach JSON result may carry the additive `reconnectAttempts` number. Hosts
must ignore this field when it is absent or when running a version that does not emit it.

### Host-driven reconnect

The optional Forca terminal-host integration, `devbox shell reconnect --all`, shells out to the Forca CLI using
`forca status --json`, `forca worktree current --json`, `forca terminal list --json`, and
`forca terminal create --worktree <selector> --command <text> --title <name> --json`.
Since 0.6.9, a session that `forca terminal list --json` already reports on a terminal
(`result.terminals[].devbox.profileId` + `.sessionName`, published by Forca builds with
native devbox tabs) is not opened again: its row gets `status: "already-open"` and that
terminal's `handle`. A Forca without the field, or a failing/unparseable list, reads as
"none open" and changes nothing. Devbox is consuming the host's CLI here; these calls are not a new Devbox contract surface. The local
`~/.local/state/devbox/shell-attach-history.json` file is internal attach history, and
hosts must not read it or depend on its shape.

## Machine-readable discovery

Run the standalone binary on the remote host over the profile's SSH connection. The
remote command argv must be exactly the Devbox command shown below; the SSH wrapper
and its pinned endpoint are host-owned. `--json` is a global flag, even where the
subcommand spec's `allowedFlags` list is empty (`src/cli/args.ts:20-25`,
`src/cli/index.ts:52-60`).

All successful JSON discovery responses have this envelope:

```text
schemaVersion: number (currently 1)
command: string
ok: true
operationKey: string (32 lowercase hexadecimal characters)
result: object
```

The serialized object keys are sorted, but hosts must use JSON field names rather
than depend on key order (`src/cli/format.ts:239-243`). `operationKey` is a
content-derived acknowledgement key, not a shell identity (`src/cli/operation-key.ts:3-5`).
On failure, the JSON envelope has `schemaVersion`, `command`, `ok: false`, and
`error: { code: string, message: string, retryable: boolean }`, with optional
`context` or `blocked`; there is no successful `result` (`src/cli/format.ts:42-56`).

### List shells

Exact remote command:

```sh
ssh -p <port> <user>@<host> devbox shell ls --profile <profile-id> --json
```

`devbox shell ls` requires a selected profile and the handler returns the shell-list
result (`src/cli/specs.ts:33-43`, `src/cli/shell-handler.ts:7-17`). Its result shape is:

```text
profileId: string
mostRecentId: number | null
sessions: array, sorted by ascending id
```

Each session has these fields and types: `id: number`, optional `name: string`,
`sessionName: string`, `created: number`, `attached: boolean`, `lastUsed: number`,
`currentCommand: string`, `currentTitle: string`, and `mostRecent: boolean`
(`src/cli/shell-sessions.ts:11-24`, `src/cli/shell.ts`). `created` and `lastUsed`
are tmux epoch-second values from `session_created` and `session_activity`; the pane
fields come from `pane_current_command` and `pane_title` (`src/cli/shell-tmux.ts`).
`mostRecentId` identifies the same session whose
`mostRecent` is `true`; Devbox chooses it by last-used time, then creation time, then
id (`src/cli/shell-sessions.ts:99-107`).

Example successful payload:

```json
{
  "command": "shell ls",
  "ok": true,
  \"operationKey\": \"<32-hex-character-key>\",
  "result": {
    "mostRecentId": 2,
    "profileId": "roam",
    "sessions": [
      {
        "attached": true,
        "created": 1710000000,
        "currentCommand": "bash",
        "currentTitle": "main",
        "id": 1,
        "lastUsed": 1710000010,
        "mostRecent": false,
        "sessionName": "devbox-roam-1"
      },
      {
        "attached": false,
        "created": 1710000001,
        "currentCommand": "phi",
        "currentTitle": "worker",
        "id": 2,
        "lastUsed": 1710000020,
        "mostRecent": true,
        "name": "worker",
        "sessionName": "devbox-roam-2-worker"
      }
    ]
  },
  "schemaVersion": 1
}
```

### List profiles

Exact remote command:

```sh
ssh -p <port> <user>@<host> devbox profile list --json
```

The command is not profile-scoped (`src/cli/specs.ts:89-93`,
`src/cli/index.ts:154-156`). Its result has an optional `defaultProfile: string`
(the field is omitted when there is no valid configured default) and
`profiles: array` (`src/cli/profile-preferences.ts:18-21`,
`src/cli/profile-preferences.ts:42-63`). Each profile has exactly these discovery
fields: `id: string`, `displayName: string`, `host: string`, `port: number`,
`username: string`, `localRoot: string`, and `remoteRoot: string`
(`src/cli/profile-preferences.ts:8-16`).

Example successful payload:

```json
{
  "command": "profile list",
  "ok": true,
  \"operationKey\": \"<32-hex-character-key>\",
  "result": {
    "defaultProfile": "roam",
    "profiles": [
      {
        "displayName": "Roaming workstation",
        "host": "devbox.example",
        "id": "roam",
        "localRoot": "/home/alice/src/project",
        "port": 22,
        "remoteRoot": "/home/alice/src/project",
        "username": "alice"
      }
    ]
  },
  "schemaVersion": 1
}
```

### Version/presence probe

Exact remote command:

```sh
ssh -p <port> <user>@<host> devbox --version
```

This probe has **no JSON mode**. On the current binary it exits successfully and
writes this human output, including the trailing newline:

```text
devbox 0.2.4 (previously devbox 0.1.8)
```

`-v` and `version` are accepted aliases (`src/cli/index.ts:38-40`), and the current
version constant is `0.2.4` (`src/cli/version.ts:1`). The version token changes when
the binary changes, so parsing this human line is best-effort: use command success and
the `devbox ` prefix for a presence check, and treat the version as informational.

## Remote cwd rules

A shell cwd must be an absolute remote path and must not contain NUL
(`src/cli/shell.ts:70-83`). The precedence for a new shell is exactly:

```text
cwdOverride ?? profileShellDir ?? remoteRoot
```

(`src/cli/shell.ts:70-76`). A new shell additionally requires the selected directory
to pass remote `test -d` before creation (`src/cli/shell.ts:85-94`).

`~` and `~/...` are not expanded; both are rejected as non-absolute paths. Do not
send them as a workaround. If a caller bypasses validation and gives a literal `~`
to tmux, it is an ordinary `-c "$cwd"` argument, not shell tilde syntax; tmux treats
it as a real relative path, `new-session` fails, and the wrapper's `set -e` exits
(`src/cli/shell.ts:59-64`).

## Credential/env staging for attached shells

When a profile credential env file is configured, Devbox stages it at exactly:

```text
/dev/shm/devbox-<profile-id>.env
```

The profile id used by this path must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`
(`src/core/devbox-credential-env.ts:5-7`, `src/core/devbox-credential-env.ts:50-55`).
Staging refuses to proceed unless `/dev/shm` exists and is `tmpfs`; it never falls
back to disk. The script sets `umask 077`, writes a per-process temporary file,
sets mode `600`, replaces the destination with `mv -f`, and verifies mode `600`
(`src/core/devbox-credential-env.ts:80-105`). This is the atomic-replace boundary.

For a newly created credential-bearing session, the exact command appended to
`tmux new-session` is:

```sh
set -a; . /dev/shm/devbox-<profile-id>.env 2>/dev/null; set +a; exec $SHELL
```

(`src/core/devbox-credential-env.ts:132-135`, `src/cli/shell.ts:57-65`). Devbox also refreshes the existing tmux session environment with targeted
`set-environment -t` calls after staging. Private sessions use the same
`tmux -f /dev/null -L <profile-socket>` invocation; legacy default-socket sessions
use plain `tmux` (`src/core/devbox-credential-env.ts`). A host must treat this file as opaque:
it must not read, copy, or log the file's contents or values. Pass only the configured
env-file path to Devbox and rely on Devbox's staging/redaction boundary.

## Bridge capability environment

The single bridge environment key is exactly:

```text
DEVBOX_BRIDGE_CAPABILITY
```

The value is a short-lived, session-scoped capability: Devbox issues it only for a
managed interactive session, gives it an expiry, and intentionally has no representable
capability for a detached job (`src/shared/devbox-bridge-capabilities.ts:65-82`,
`src/shared/devbox-bridge-capabilities.ts:98-113`). A host must explicitly allowlist
this one key for the approved interactive process. It must **never** copy this key
into a detached job environment; detached-job issuance is refused and the job env
validator denies the key and bridge/capability-shaped keys
(`src/shared/devbox-job-environment.ts:1-6`, `src/shared/devbox-job-environment.ts:22-55`).
See [`docs/embedding.md`](embedding.md#bridge-capability-environment-key) for the
embedding-wide bridge policy.

## tmux prerequisite and remediation

Before shell operations Devbox runs:

1. `command -v tmux`; a non-empty result succeeds.
2. If that probe fails or is empty, `sudo -n true` checks for passwordless sudo.
3. If that check fails, Devbox stops without prompting and reports exactly:
   `tmux is not installed and passwordless sudo is unavailable. Install it with: sudo -n apt-get install -y --no-install-recommends tmux`.
4. If sudo is available, it reports `tmux not found; installing with: sudo -n apt-get install -y --no-install-recommends tmux`, runs that exact non-interactive install command, and probes `command -v tmux` again.
5. An install failure reports `tmux installation failed` plus the runner detail. If the post-install probe still fails, it reports exactly:
   `tmux installation completed but tmux is still unavailable. Install it with: sudo -n apt-get install -y --no-install-recommends tmux`.

These commands and messages are the prerequisite contract
(`src/cli/shell.ts:11-12`, `src/cli/shell.ts:132-170`). A host should surface the
returned message verbatim instead of reducing it to an opaque SSH failure.

## Host implementation checklist

- Probe the remote binary with `devbox --version`; treat the human line as best-effort.
- Use `devbox profile list --json` to resolve the profile id and remote root.
- Use `devbox shell ls --profile <id> --json` and consume the envelope/result fields verbatim.
- Build names only with the documented sanitizer, prefix, positive id, and optional name; never create a second namespace.
- Do not cache ids across removal; re-discover before attaching to a cached identity.
- Apply `cwdOverride ?? profileShellDir ?? remoteRoot`, and reject relative, NUL-containing, or tilde paths.
- Let Devbox own tmux options and present its exact prerequisite remediation without replacement.
- For a new shell, let Devbox derive and use the private profile socket; do not invent a socket or session namespace.
- Treat `shell ls` as canonical-only; use `shell rm`/`shell rm --all` for cleanup of validated v0.1.5 legacy names. `rm --all` is idempotent and may report one canonical name for each socket when both exist.
- Allowlist `DEVBOX_BRIDGE_CAPABILITY` only for approved interactive processes; never pass it to detached jobs or log credential contents.
