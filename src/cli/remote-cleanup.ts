import { shellEscape } from '../ssh/shell-escape'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'

type ProfileCleanupIdentity = {
  id: string
  roots: { remoteRoot: string }
}

export async function cleanupRemoteAgents(
  runner: DevboxSshRunner,
  profile: ProfileCleanupIdentity
): Promise<void> {
  const profileState = `.local/state/devbox/${profile.id}`
  const script = [
    'set -u',
    `profile_state="$HOME/${profileState}"`,
    `workspace=${shellEscape(profile.roots.remoteRoot)}`,
    'self=$$',
    'for pid in $(ps -eo pid=); do',
    '  [ "$pid" = "$self" ] && continue',
    '  args=$(ps -p "$pid" -o args= 2>/dev/null || true)',
    '  case "$args" in *mutagen-agent*) ;; *) continue ;; esac',
    '  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)',
    '  case "$args $cwd" in *"$profile_state"*|*"$workspace"*) kill -TERM "$pid" 2>/dev/null || true ;; esac',
    'done',
    'sleep 0.2',
    'exit 0'
  ].join('\n')
  await runner.command(script, 10_000).catch(() => undefined)
}
