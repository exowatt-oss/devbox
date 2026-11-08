# Devbox first-time setup

A **hub** is an SSH host with a remote workspace root; local **spokes** pair with it via Mutagen's two-way-safe sync. Spokes do not directly synchronize with each other. Follow these steps on machines you own or administer; never adopt or delete existing directories without inspecting them first.

## Prerequisites

Install the [public release](docs/INSTALL.md) on your macOS or Linux machine. The remote hub needs an OpenSSH server, your authorized public key, `rsync` with zstd support, `tmux` for shells and (for detached jobs on Linux) a running `systemd --user` manager. On Ubuntu, install the missing tools with the system package manager; use an account you administer and enable user linger if jobs must survive logouts. macOS hubs support shells but not detached systemd jobs. Confirm the remote host key fingerprint from a trusted out-of-band source.

## Create the hub relationship

On the machine whose local files should seed an empty remote root:

```sh
db init --host devbox.example.com --user alice \
  --local-root ~/work --remote-root /home/alice/work \
  --fingerprint SHA256:<reviewed-host-key>
db mutagen status
db sync
db status
```

If the remote root contains anything, stop: `--adopt-remote` explicitly opts into safe two-way conflict handling, not a silent overwrite. Do not use `--yes` unless you cannot pre-verify the host key.

On another machine joining the **same** hub and root:

```sh
db connect --host devbox.example.com --user alice \
  --remote-root /home/alice/work \
  --fingerprint SHA256:<reviewed-host-key>
db sync
db status
```

The default local root for `connect` is `$HOME/<remote-root basename>`; use `--local-root` to choose another. The local root must be empty unless you explicitly use `--allow-non-empty-local` after inspecting both trees. `db profile list --json` shows saved endpoints and roots. `db preflight --json` explains unmet requirements.

## Daily use and safety

`db sync` resumes, flushes and pauses the app-owned Mutagen sessions; there is no continuous sync. `.git`, credential stores, generated output and runtime state are excluded or handled separately. Use `db shell` for a persistent remote tmux session; `db run -- <command>` creates a detached job on a Linux hub, and `db ports open --remote-port 8080` forwards a port. For multiple hubs, select a profile with `db device --default <alias>` or `--profile <id>`.

For a changing address reachable through an SSH proxy, configure `ProxyCommand` in your own `~/.ssh/config` and pass the same `--proxy-command` in `db init`/`db connect`; the SSH host key remains pinned. No specific hosting provider or private service is required. See [quickstart](docs/QUICKSTART.md) and [recovery](docs/devbox-recovery.md) for advanced usage. `db disable --profile <id>` stops only owned sessions; it never deletes workspace files.
