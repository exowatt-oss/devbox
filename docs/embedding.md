# Embedding Devbox

Devbox is a standalone CLI and runtime. Host applications may embed its
orchestrator or launch the bundled CLI, but they must treat the contracts below
as explicit boundaries rather than reaching into Devbox state directly. Hosts that
attach to Devbox-owned remote tmux shells must also follow [`INTEROP.md`](INTEROP.md).

## Zero-environment contract

Installing the standalone binary is the opt-in. Profile operations work with zero
required environment variables. An embedding host may provide optional configuration
such as `DEVBOX_STATE_ROOT` or the approved `DEVBOX_MUTAGEN_BINARY` override, but the
CLI does not require either value.

## Bridge capability environment key

The bridge capability is passed to an approved remote process through exactly
one environment key:

```text
DEVBOX_BRIDGE_CAPABILITY
```

Embedding hosts must allowlist this key when constructing the environment for a
Devbox-launched process. The value is a serialized, short-lived,
session-scoped capability. It is not a general-purpose credential and must not
be copied into detached job environments. The capability authorizes only the
remote MCP OAuth operations declared by the session, and expired or
out-of-scope capabilities are rejected.

## Remote MCP OAuth wire contract

The remote bridge command is `__devbox_mcp_oauth`. Protocol version `1` uses
JSON request/response objects with the following operations:

- `prepare`: request ID, MCP server name, remote callback port, callback path,
  and an optional preferred redirect URI;
- `open`: lease ID, authorization URL, and redirect URI; and
- `close`: request ID, optional lease ID, and outcome (`complete`, `cancelled`,
  or `failed`).

Successful responses are `ready`, `opened`, or `closed`; failures use the
bounded error code set in `src/shared/remote-mcp-oauth-contract.ts`. OAuth
leases last thirty minutes, callback paths are `/oauth/callback`, authorization
URLs must be HTTPS without embedded credentials or fragments, and request,
response, URL, server-name, request-ID, lease-ID, and state sizes are bounded
by the constants in that module. Keep the protocol fixtures there unchanged
when implementing another adapter.

## Job environment policy

Detached jobs receive only the explicitly supplied, validated environment
mapping. Keys and values must be NUL-free and keys must match the shell-safe
identifier form. Credential-bearing keys, bridge/capability keys, tokens,
passwords, private keys, authorization values, and similar secret-shaped names
are rejected by `validateDevboxJobEnvironment`.

Jobs run under app-owned `systemd --user` units named
`devbox-<job-id>-<spec-hash-prefix>.service`. Their registry and logs live
under the profile's remote state root:

```text
$HOME/.local/state/devbox/<profile-id>/jobs
```

## State and ownership

Local state defaults to `$HOME/.local/state/devbox`; an embedding host may
provide `DEVBOX_STATE_ROOT`. Remote generation, backup, witness, and job state
must remain below `$HOME/.local/state/devbox/<profile-id>`. Mutagen sessions are
owned only when all four labels are present and agree:

```text
devbox-profile
devbox-session
devbox-root-class
devbox-backend
```

Disable and cleanup operations must continue to require the complete label set;
matching a single label or a partial set is never sufficient. Embeddings should
use the exported label constants and the Devbox state roots instead of
inventing a second namespace.
