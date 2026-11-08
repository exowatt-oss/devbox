# Devbox

![Status: maintained](https://img.shields.io/badge/status-maintained-brightgreen) ![License: Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

Devbox pairs local workspaces with remote SSH hosts for safe on-demand Mutagen sync, persistent tmux shells, detached jobs on Linux, and port forwarding.

Created at [Exowatt](https://exowatt.com).

## Status

Maintained. Releases target macOS arm64/x64 and Linux arm64/x64.

## Install

Public GitHub release assets require no credentials. Download and inspect the [installer](https://github.com/exowatt-oss/devbox/releases/latest/download/devbox-install.sh), then run:

```sh
sh ./devbox-install.sh
```

The installer verifies the archive using the release's `SHA256SUMS` and installs to `~/.local/bin` by default. Set `DEVBOX_INSTALL_DIR` for another destination, `DEVBOX_VERSION=vX.Y.Z` for a tagged release, or `DEVBOX_RELEASE_REPO=owner/repo` for a fork. See [installation and source build](docs/INSTALL.md).

## Quickstart

Prepare an SSH-accessible host with a known host key and an empty remote workspace. For persistent shells, install tmux there; for detached jobs use a Linux host with systemd user services. Run `db` or `devbox` (both names refer to the same CLI):

```sh
# Start from the machine with the existing files:
db init --host devbox.example.com --user alice --local-root ~/work --remote-root /home/alice/work --fingerprint SHA256:<reviewed-host-key>
# On another machine, join that same hub:
db connect --host devbox.example.com --user alice --remote-root /home/alice/work --fingerprint SHA256:<reviewed-host-key>
db sync
db status
db shell
```

Verify the host-key fingerprint out of band. Do not pair nonempty roots without reading the conflict and adoption guidance in [agent setup](AGENT-SETUP.md). See [operator quickstart](docs/QUICKSTART.md) for profiles, recovery and teardown.

## Configuration

No hosted service, private GitHub release, account token or organization configuration is needed. Profiles store SSH endpoint, pinned host key, local and remote roots, sync exclusions and optional proxy command under `${DEVBOX_STATE_ROOT:-$HOME/.local/state/devbox}`. Mutagen v0.18.1 is fetched from its public release and checksum-verified on first sync; use `DEVBOX_MUTAGEN_BINARY` to select a separately installed binary. Devbox downloads Mutagen at runtime; Mutagen is a separately licensed third-party tool (see its licence; some official release builds include SSPL-licensed components) and is not redistributed by this project. `DEVBOX_POWER_CLI` optionally names a power-provider executable for checking a proxy-powered host's `status` before syncing; without it no provider is called. `DEVBOX_RELEASE_REPO` selects an alternate public GitHub `owner/repo` for the installer (default `exowatt-oss/devbox`). Use `db profile --help`, `db device --help`, `db mutagen status` and [the reference](docs/devbox.md).

## Development

Node.js 24 and pnpm 10.24.0:

```sh
pnpm install --frozen-lockfile
pnpm run ci
pnpm bundle
```

## License

Original code is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE).

## Contributing

See [CONTRIBUTING](https://github.com/exowatt-oss/.github/blob/main/CONTRIBUTING.md). Sign off commits with `git commit -s` (DCO).

## Security

Report vulnerabilities through [private vulnerability reporting](https://github.com/exowatt-oss/devbox/security/advisories/new), or email software@exowatt.com. See the [security policy](https://github.com/exowatt-oss/.github/blob/main/SECURITY.md); do not open a public issue.
