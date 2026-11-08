# Install Devbox

Release archives are public at [exowatt-oss/devbox](https://github.com/exowatt-oss/devbox/releases). No GitHub authentication or token is required.

## Install or update

Download and inspect `devbox-install.sh` from the [latest release](https://github.com/exowatt-oss/devbox/releases/latest/download/devbox-install.sh), then run:

```sh
sh ./devbox-install.sh
```

The script downloads the matching archive plus `SHA256SUMS` over HTTPS, verifies SHA-256, installs `devbox` (and a `db` alias) to `$HOME/.local/bin`, and preserves a preexisting unrelated executable. Repeat for upgrades. Use `DEVBOX_VERSION=vX.Y.Z` to pin a release or `DEVBOX_RELEASE_REPO=owner/repo` for your own public fork; `DEVBOX_INSTALL_DIR` chooses the destination.

Supported artifacts: `devbox-darwin-arm64.tar.gz`, `devbox-darwin-x64.tar.gz`, `devbox-linux-x64.tar.gz`, and `devbox-linux-arm64.tar.gz`. Each contains one executable, a README, LICENSE, NOTICE and THIRD-PARTY-NOTICES (including bundled dependency licenses and the Node.js runtime license when present in the build installation; otherwise the notices give the matching Node.js source-download URL). Verify the archive's build provenance with `gh attestation verify devbox-<target>.tar.gz --repo exowatt-oss/devbox` after downloading the asset; use the selected `DEVBOX_RELEASE_REPO` in place of the default for forks. The installer verifies SHA-256 independently.

## Build from source

Requires Node.js 24 and pnpm 10.24.0. Clone the public repository and run:

```sh
git clone https://github.com/exowatt-oss/devbox.git
cd devbox
pnpm install --frozen-lockfile
pnpm run ci
pnpm bundle
node dist/cli/index.mjs --version
```

For a native single executable for your machine, run `pnpm build:sea`; see [release instructions](RELEASE.md).

## Prerequisites

A reachable OpenSSH host and verified SSH host key are required for pairing. Mutagen is downloaded on demand from its public official release and checked against a pinned digest; `DEVBOX_MUTAGEN_BINARY` optionally supplies your own. Devbox downloads Mutagen at runtime; Mutagen is a separately licensed third-party tool (see its licence; some official release builds include SSPL-licensed components) and is not redistributed by this project. A Linux hub needs `systemd --user` for detached jobs; tmux enables persistent shells. See [first-time setup](../AGENT-SETUP.md).
