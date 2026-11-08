import { readFileSync } from 'node:fs'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import { redactStringValue } from './devbox-redactor-strings'

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const HEREDOC_DELIMITER = 'DEVBOX_ENV_FILE'

export type DevboxCredentialEnvironment = Readonly<Record<string, string>>

export function parseDevboxEnvFile(contents: string, source = 'env file'): DevboxCredentialEnvironment {
  const environment: Record<string, string> = {}
  const lines = contents.split('\n')
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const leftTrimmed = line.trimStart()
    if (leftTrimmed.length === 0 || leftTrimmed.startsWith('#')) {
      continue
    }
    if (line.includes('\u0000') || line.includes('\r')) {
      throw invalidEnvFile(source, lineNumber)
    }
    const candidate = leftTrimmed.startsWith('export ')
      ? leftTrimmed.slice('export '.length)
      : leftTrimmed
    const separator = candidate.indexOf('=')
    if (separator <= 0) {
      throw invalidEnvFile(source, lineNumber)
    }
    const key = candidate.slice(0, separator)
    if (!ENV_KEY_PATTERN.test(key)) {
      throw invalidEnvFile(source, lineNumber)
    }
    environment[key] = candidate.slice(separator + 1)
  }
  return environment
}

export function readDevboxEnvFile(path: string): DevboxCredentialEnvironment {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Unable to read credential env file: ${path}`)
  }
  return parseDevboxEnvFile(contents, path)
}

/**
 * Linux hub path: tmpfs-backed /dev/shm so staged credentials never touch disk.
 * Detached jobs (systemd-only, hence Linux-only) read this path directly.
 */
export function devboxCredentialEnvRemotePath(profileId: string): string {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('Invalid Devbox profile identifier.')
  }
  return `/dev/shm/devbox-${profileId}.env`
}

/**
 * macOS hub path: the per-user private temp dir (mode 0700, created on demand by
 * confstr). macOS has no /dev/shm; this is the closest user-private analogue.
 * Returned as a shell expression, evaluated on the remote.
 */
export function devboxCredentialEnvDarwinRemotePathExpression(profileId: string): string {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('Invalid Devbox profile identifier.')
  }
  return `$(getconf DARWIN_USER_TEMP_DIR)devbox-${profileId}.env`
}

/**
 * One-line POSIX snippet that sets `$devbox_env_path` to the platform-correct
 * credential path. Every shell/tmux consumer uses this so staging, sourcing,
 * refreshing, and cleanup always agree on the same file, on either hub OS.
 */
export function buildDevboxCredentialEnvPathSnippet(profileId: string): string {
  const linux = shellQuote(devboxCredentialEnvRemotePath(profileId))
  const darwin = devboxCredentialEnvDarwinRemotePathExpression(profileId)
  return `devbox_env_path=${linux}; if [ "$(uname -s)" = Darwin ]; then devbox_env_path="${darwin}"; fi`
}

export async function stageDevboxCredentialEnv(
  runner: DevboxSshRunner,
  profileId: string,
  localPath: string
): Promise<{ remotePath: string; keys: readonly string[] }> {
  const environment = readDevboxEnvFile(localPath)
  const remotePath = devboxCredentialEnvRemotePath(profileId)
  try {
    await runner.script(buildDevboxCredentialEnvStageScript(profileId, environment), 15_000)
  } catch (error) {
    throw new Error(`Credential env staging failed: ${redactError(error)}`)
  }
  return { remotePath, keys: Object.keys(environment).sort() }
}

export async function removeDevboxCredentialEnv(
  runner: DevboxSshRunner,
  profileId: string
): Promise<void> {
  await runner.command(`${buildDevboxCredentialEnvPathSnippet(profileId)}; rm -f -- "$devbox_env_path"`, 10_000)
}

export function buildDevboxCredentialEnvStageScript(
  profileId: string,
  environment: DevboxCredentialEnvironment
): string {
  const body = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')
  return [
    'set -Eeuo pipefail',
    'umask 077',
    buildDevboxCredentialEnvPathSnippet(profileId),
    // Linux: refuse anything but tmpfs so credentials never persist to disk.
    // Darwin: the per-user temp dir is the platform's private scratch space.
    'if [ "$(uname -s)" != Darwin ]; then',
    "  if [ ! -d /dev/shm ]; then printf '%s\\n' 'Devbox credential staging requires /dev/shm.' >&2; exit 1; fi",
    '  fstype=$(stat -f -c %T /dev/shm 2>/dev/null || true)',
    '  if [ "$fstype" != tmpfs ]; then fstype=$(findmnt -n -o FSTYPE --target /dev/shm 2>/dev/null || true); fi',
    "  if [ \"$fstype\" != tmpfs ]; then printf '%s\\n' 'Devbox credential staging requires /dev/shm to be tmpfs; refusing disk fallback.' >&2; exit 1; fi",
    'fi',
    'tmp="$devbox_env_path.tmp.$$"',
    'remote="$devbox_env_path"',
    `cat > "$tmp" <<'${HEREDOC_DELIMITER}'`,
    body,
    HEREDOC_DELIMITER,
    'chmod 600 "$tmp"',
    'mv -f "$tmp" "$remote"',
    'actual_mode=$(stat -c %a "$remote" 2>/dev/null || stat -f %Lp "$remote" 2>/dev/null || true)',
    "if [ \"$actual_mode\" != 600 ]; then printf '%s\\n' 'Devbox credential staging could not enforce mode 600.' >&2; rm -f -- \"$tmp\" \"$remote\"; exit 1; fi"
  ].join('\n')
}

export function buildDevboxShellEnvironmentRefreshScript(
  profileId: string,
  sessionName: string,
  socketName?: string
): string {
  const tmux = socketName === undefined
    ? 'tmux'
    : `tmux -f /dev/null -L ${shellQuote(socketName)}`
  return [
    'set -Eeuo pipefail',
    `session=${shellQuote(sessionName)}`,
    buildDevboxCredentialEnvPathSnippet(profileId),
    'env_file="$devbox_env_path"',
    `${tmux} has-session -t "$session" 2>/dev/null`,
    'set -a; . "$env_file" 2>/dev/null; set +a',
    'while IFS= read -r line || [ -n "$line" ]; do',
    '  [ -n "$line" ] || continue',
    '  key=${line%%=*}',
    '  value=${!key}',
    // Why: `tmux -C` with no attach target CREATES a session on every call, so the
    // old per-var control-mode pipe leaked one orphan tmux session per env var on
    // every shell attach (293 orphans found on one host). Direct set-environment
    // leaks none, and needs no %q quoting because tmux receives the value as a
    // single argv entry rather than a parsed control-mode line.
    `  ${tmux} set-environment -t "$session" "$key" "$value"`,
    'done < "$env_file"'
  ].join('\n')
}

export function buildDevboxShellSourceCommand(profileId: string): string {
  return `${buildDevboxCredentialEnvPathSnippet(profileId)}; set -a; . "$devbox_env_path" 2>/dev/null; set +a; exec $SHELL`
}

function invalidEnvFile(source: string, lineNumber: number): Error {
  return new Error(`Invalid credential env file ${source} at line ${lineNumber}; expected KEY=VALUE.`)
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const redacted = redactStringValue(message, 16_384)
  return typeof redacted === 'string' ? redacted : '[REDACTED]'
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
