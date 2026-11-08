#!/bin/sh
set -eu

# Download public release assets. Override DEVBOX_RELEASE_REPO to use a fork.

if [ -z "${HOME:-}" ]; then
  echo "devbox-install: HOME must be set" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "devbox-install: curl is required" >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "devbox-install: tar is required" >&2
  exit 1
fi

# Map `uname -s` / `uname -m` to a release target (printed on stdout).
devbox_target() {
  case "$1:$2" in
    Darwin:arm64|Darwin:aarch64) echo darwin-arm64 ;;
    Darwin:x86_64|Darwin:amd64) echo darwin-x64 ;;
    Linux:x86_64|Linux:amd64) echo linux-x64 ;;
    Linux:arm64|Linux:aarch64) echo linux-arm64 ;;
    *) return 1 ;;
  esac
}

os=$(uname -s)
arch=$(uname -m)
if ! target=$(devbox_target "$os" "$arch"); then
  echo "devbox-install: unsupported platform ${os} ${arch} (targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64)" >&2
  exit 1
fi

repo=${DEVBOX_RELEASE_REPO:-exowatt-oss/devbox}
case "$repo" in
  ?*/?*) ;;
  *) echo "devbox-install: DEVBOX_RELEASE_REPO must be owner/repo" >&2; exit 1 ;;
esac
owner=${repo%%/*}
name=${repo#*/}
for component in "$owner" "$name"; do
  case "$component" in
    *[!A-Za-z0-9_.-]*|*..*|.*|-*)
      echo "devbox-install: DEVBOX_RELEASE_REPO must be a GitHub owner/repo" >&2; exit 1 ;;
  esac
done
if [ -n "${DEVBOX_VERSION:-}" ]; then
  tag=$DEVBOX_VERSION
  case "$tag" in
    *[!A-Za-z0-9._-]*|.*|*..*|*/) echo "devbox-install: invalid DEVBOX_VERSION" >&2; exit 1 ;;
  esac
  release_base="https://github.com/${repo}/releases/download/${tag}"
else
  tag=latest
  release_base="https://github.com/${repo}/releases/latest/download"
fi

install_dir=${DEVBOX_INSTALL_DIR:-$HOME/.local/bin}
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/devbox-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' 0 HUP INT TERM

archive_name="devbox-${target}.tar.gz"
archive_path="$tmp_dir/$archive_name"
checksums_path="$tmp_dir/SHA256SUMS"

curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
  "$release_base/$archive_name" --output "$archive_path"
curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
  "$release_base/SHA256SUMS" --output "$checksums_path"

expected=$(awk -v filename="$archive_name" '$2 == filename { print $1; exit }' "$checksums_path")
if [ -z "$expected" ]; then
  echo "devbox-install: SHA256SUMS has no entry for $archive_name" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive_path" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive_path" | awk '{ print $1 }')
else
  echo "devbox-install: shasum or sha256sum is required for verification" >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "devbox-install: checksum mismatch for $archive_name" >&2
  exit 1
fi

mkdir -p "$install_dir"
tar -xzf "$archive_path" -C "$tmp_dir" devbox
chmod +x "$tmp_dir/devbox"

# A script at the devbox destination belongs to another tool. Preserve it
# and install our binary as db instead.
is_foreign_devbox() {
  [ -f "$1" ] && [ "$(head -c 2 "$1" 2>/dev/null)" = '#!' ]
}

# Atomic replace: copy beside the target, then rename over it.
install_file() {
  cp "$tmp_dir/devbox" "$1.devbox-install.$$"
  chmod 755 "$1.devbox-install.$$"
  mv -f "$1.devbox-install.$$" "$1"
}

db_path="$install_dir/db"
if is_foreign_devbox "$install_dir/devbox"; then
  # A db symlink (an older Devbox install's `db -> devbox`) is replaced by the real file.
  if [ ! -L "$db_path" ] && is_foreign_devbox "$db_path"; then
    echo "devbox-install: both $install_dir/devbox and $db_path belong to another tool; not installing" >&2
    exit 1
  fi
  install_file "$db_path"
  installed_path=$db_path
  echo "devbox-install: note: $install_dir/devbox is another script; left it alone and installed this release as $db_path — use 'db'" >&2
else
  install_file "$install_dir/devbox"
  installed_path="$install_dir/devbox"
  if [ ! -e "$db_path" ] && [ ! -L "$db_path" ]; then
    ln -s devbox "$db_path"
  elif [ -L "$db_path" ]; then
    db_target=$(readlink "$db_path" 2>/dev/null || true)
    case "$db_target" in
      devbox|./devbox|"$install_dir/devbox")
        ln -sfn devbox "$db_path"
        ;;
      *)
        echo "devbox-install: warning: leaving existing db at $db_path (not a devbox symlink)" >&2
        ;;
    esac
  else
    echo "devbox-install: warning: leaving existing db at $db_path (not a symlink)" >&2
  fi
fi

echo "Installed Devbox ($target, $tag) to $installed_path"
case ":${PATH}:" in
  *":${install_dir}:"*)
    ;;
  *)
    echo "Add $install_dir to PATH, for example:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac
