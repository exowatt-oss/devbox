# Devbox releases

Public releases live at [exowatt-oss/devbox](https://github.com/exowatt-oss/devbox/releases); no user token is needed to download them. Maintainers with publish permission tag a reviewed commit; the GitHub Actions release workflow builds native Node 24 executables, uploads platform archives, an installer and `SHA256SUMS`.

## Cut a release

1. Find the latest published tag in your release repository (`DEVBOX_RELEASE_REPO`, default `exowatt-oss/devbox`): `gh release list --repo exowatt-oss/devbox --limit 1`. Choose a newer semantic version.
2. Update `package.json` version and `DEVBOX_VERSION` in `src/cli/version.ts` together. Run `pnpm install --frozen-lockfile`, `pnpm run ci`, `pnpm bundle`, `pnpm build:sea`, and `node config/scripts/check-release-tag.mjs vX.Y.Z` locally on the appropriate platform. Validate the generated binary with `--version`.
3. Merge a DCO-signed, reviewed pull request into `main`; tag that commit `vX.Y.Z` and push the tag. The release workflow verifies the tag against both version sources and runs the four-platform build matrix before publishing.
4. Verify each platform's archive (including LICENSE, NOTICE and THIRD-PARTY-NOTICES), installer, `SHA256SUMS` and build provenance (`gh attestation verify devbox-<target>.tar.gz --repo exowatt-oss/devbox`) in the published release. Check that installation via `DEVBOX_VERSION=vX.Y.Z sh ./devbox-install.sh` succeeds on representative hosts.

Do not publish a tag while CI is failing. Only maintainers need a GitHub token for publishing; installers never use one.

## Rollback

Pick a prior published tag and run `DEVBOX_VERSION=vX.Y.Z sh ./devbox-install.sh` with the public installer. The installer verifies SHA-256 before replacing the binary. Rollback does not delete profiles, Mutagen sessions, workspace files or journals.
