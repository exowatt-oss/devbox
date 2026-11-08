import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxOperationPhase, DevboxProfileV1 } from '../shared/devbox-types'
import type {
  DevboxExecRequest,
  DevboxExecResult,
  DevboxInventoryEntry,
  DevboxPreflightCheck,
  DevboxPreflightCheckId
} from './devbox-preflight-types'

export const DEVBOX_REQUIRED_RSYNC_OPTIONS = [
  '--archive',
  '--hard-links',
  '--sparse',
  '--no-owner',
  '--no-group',
  '--partial',
  '--partial-dir=.rsync-partial',
  '--timeout=120',
  '--compress',
  '--compress-choice=zstd',
  '--protect-args'
] as const

export const STAGES = [
  ['connectivity', 'preflighting'],
  ['platform', 'preflighting'],
  ['prerequisites', 'preflighting'],
  ['capacity', 'preflighting'],
  ['paths', 'preflighting'],
  ['preview', 'awaiting-review']
] as const satisfies readonly (readonly [string, DevboxOperationPhase])[]

export type DevboxPreflightExec = (
  side: 'local' | 'remote',
  request: DevboxExecRequest
) => Promise<DevboxExecResult | undefined>

type SafeDetail = string | number | boolean | readonly string[]

export function errorFor(
  field: string,
  code: 'unknown' | 'ssh_identity_mismatch' | 'disk_pressure' = 'unknown'
): DevboxError {
  return createDevboxError(code, {
    retryable: code === 'unknown',
    context: { field }
  })
}

export function parseNumber(raw: string): number | undefined {
  const match = raw.match(/(?:^|\n)\s*([0-9][0-9,]*)\s*(?:\n|$)/)
  if (!match) {
    return undefined
  }

  const value = Number(match[1]!.replaceAll(',', ''))
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function inventoryEntries(
  result: DevboxExecResult | undefined
): readonly DevboxInventoryEntry[] {
  if (result?.entries) {
    return result.entries
  }
  if (result?.exitCode !== 0) {
    return []
  }

  return result.stdout.split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line) as DevboxInventoryEntry
      return value.path && value.kind ? [value] : []
    } catch {
      return []
    }
  })
}

export function makeCheck(
  id: string,
  status: DevboxPreflightCheck['status'],
  remediation: string,
  blocking: boolean,
  details?: Record<string, SafeDetail>,
  error?: DevboxError
): DevboxPreflightCheck {
  return {
    id: id as DevboxPreflightCheckId,
    status,
    remediation,
    blocking,
    ...(details ? { details } : {}),
    ...(error ? { error } : {})
  }
}

export async function runConnectivityChecks(
  profile: DevboxProfileV1,
  exec: DevboxPreflightExec,
  checks: DevboxPreflightCheck[]
): Promise<void> {
  const result = await exec('remote', {
    command: 'printf',
    args: ['devbox-preflight-reachable']
  })
  const expected = profile.sshTarget.identity
  const observed = result?.identity

  checks.push(
    result?.exitCode === 0 && result.stdout.trim() === 'devbox-preflight-reachable'
      ? makeCheck('ssh-reachability', 'pass', '', true)
      : makeCheck(
          'ssh-reachability',
          result ? 'fail' : 'unknown',
          'Reconnect to the enrolled SSH target and rerun preflight.',
          true,
          undefined,
          errorFor('ssh-reachability')
        )
  )

  const matches =
    observed?.host === expected.host &&
    observed.port === expected.port &&
    observed.username === expected.username &&
    observed.hostKeyFingerprint === expected.hostKeyFingerprint

  checks.push(
    matches
      ? makeCheck('host-identity', 'pass', '', true, {
          host: expected.host,
          port: expected.port
        })
      : makeCheck(
          'host-identity',
          observed ? 'fail' : 'unknown',
          'Re-verify the endpoint and exact SSH host-key fingerprint before continuing.',
          true,
          undefined,
          errorFor('host-identity', observed ? 'ssh_identity_mismatch' : 'unknown')
        )
  )
}

export async function runPlatformChecks(
  exec: DevboxPreflightExec,
  checks: DevboxPreflightCheck[]
): Promise<void> {
  const kernel = await exec('remote', { command: 'uname', args: ['-s'] })
  const arch = await exec('remote', { command: 'uname', args: ['-m'] })
  const kernelName = kernel?.stdout.trim()
  const os = kernelName === 'Darwin'
    ? undefined
    : await exec('remote', { command: 'cat', args: ['/etc/os-release'] })
  const darwinRelease = kernelName === 'Darwin'
    ? await exec('remote', { command: 'sw_vers', args: ['-productVersion'] })
    : undefined
  const distro = kernelName === 'Darwin' ? 'darwin' : os?.stdout.match(/^ID="?([^"\n]+)"?/m)?.[1]
  const release = kernelName === 'Darwin'
    ? darwinRelease?.stdout.trim()
    : os?.stdout.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1]
  const machine = arch?.stdout.trim()
  const supported =
    (kernelName === 'Darwin' && arch?.exitCode === 0 && ['arm64', 'x86_64'].includes(machine ?? '')) ||
    (kernelName !== 'Darwin' && os?.exitCode === 0 && arch?.exitCode === 0 && distro === 'ubuntu' && ['22.04', '24.04'].includes(release ?? '') && ['amd64', 'x86_64', 'arm64', 'aarch64'].includes(machine ?? ''))

  checks.push(
    makeCheck(
      'os-distro-arch',
      supported ? 'pass' : os && arch ? 'fail' : 'unknown',
      'Use Ubuntu 22.04 or 24.04 on amd64 or arm64 (aarch64), or macOS arm64/x86_64 (Darwin); no mutation is allowed on another platform.',
      true,
      {
        ...(distro ? { distro } : {}),
        ...(release ? { release } : {}),
        ...(machine ? { arch: machine } : {})
      },
      supported ? undefined : errorFor('os-distro-arch')
    )
  )

  if (!supported) {
    throw new Error(kernel && arch ? 'unsupported-os' : 'preflight-unknown')
  }
}

export async function runPrerequisiteChecks(
  profile: DevboxProfileV1,
  exec: DevboxPreflightExec,
  checks: DevboxPreflightCheck[]
): Promise<void> {
  const username = profile.sshTarget.identity.username
  const platform = await exec('remote', { command: 'uname', args: ['-s'] })
  const darwin = platform?.stdout.trim() === 'Darwin'
  // Probe with a harmless real command: `sudo -n -v` validates cached
  // credentials and can demand a password even on hosts where
  // `NOPASSWD: ALL` makes every actual non-interactive sudo succeed.
  const sudo = await exec('remote', { command: 'sudo', args: ['-n', 'true'] })
  checks.push(
    makeCheck(
      'sudo',
      sudo?.exitCode === 0 ? 'pass' : darwin && sudo ? 'warn' : sudo ? 'fail' : 'unknown',
      darwin ? 'Passwordless sudo is optional on macOS hubs; no sudo-based repair is required.' :
        'Grant reviewed non-interactive sudo or use an approved privileged enrollment path; preflight never prompts.',
      !darwin,
      darwin ? { detail: 'optional: darwin' } : undefined,
      sudo?.exitCode === 0 || darwin ? undefined : errorFor('sudo')
    )
  )

  if (darwin) {
    checks.push(makeCheck('systemd-user-manager', 'pass', '', false, { detail: 'not-applicable: darwin' }))
    checks.push(makeCheck('user-linger', 'pass', '', false, { detail: 'not-applicable: darwin' }))
  } else {
    const systemd = await exec('remote', { command: 'systemctl', args: ['--user', 'is-system-running'] })
    const linger = await exec('remote', { command: 'loginctl', args: ['show-user', username, '--property=Linger', '--value'] })
    checks.push(makeCheck('systemd-user-manager', systemd?.exitCode === 0 && systemd.stdout.trim() === 'running' ? 'pass' : systemd ? 'fail' : 'unknown', 'Start a healthy systemd user manager before provisioning durable jobs.', true, undefined, systemd?.exitCode === 0 ? undefined : errorFor('systemd-user-manager')))
    const lingerOk = linger?.exitCode === 0 && /^(yes|true)$/i.test(linger.stdout.trim())
    checks.push(makeCheck('user-linger', lingerOk ? 'pass' : linger ? 'fail' : 'unknown', 'Review and enable user linger for durable jobs; the enable command is previewed but never run by preflight.', true, { enableLingerRequired: !lingerOk }, lingerOk ? undefined : errorFor('user-linger')))
  }

  for (const command of ['bash', 'python3', 'df']) {
    const result = await exec('remote', { command, args: command === 'df' && darwin ? ['-k', '/'] : ['--version'] })
    checks.push(makeCheck(`remote-${command}`, result?.exitCode === 0 ? 'pass' : result ? 'fail' : 'unknown', `Install a usable remote ${command} before provisioning.`, true, undefined, result?.exitCode === 0 ? undefined : errorFor(`remote-${command}`)))
  }

  const version = await exec('remote', { command: 'rsync', args: ['--version'] })
  const probe = await exec('remote', { command: 'rsync', args: ['--dry-run', ...DEVBOX_REQUIRED_RSYNC_OPTIONS, '/dev/null', '/tmp/devbox-preflight'] })
  const rsyncOk = version?.exitCode === 0 && /rsync\s+version\s+3\./i.test(version.stdout) && /zstd/i.test(version.stdout) && probe?.exitCode === 0
  checks.push(makeCheck('remote-rsync', rsyncOk ? 'pass' : version && probe ? 'fail' : 'unknown', darwin ? 'Install Homebrew rsync 3.x with zstd support (`brew install rsync`), then rerun preflight.' : 'Install or upgrade remote rsync with every required option, including --compress-choice=zstd, then rerun preflight.', true, { requiredOptions: DEVBOX_REQUIRED_RSYNC_OPTIONS }, rsyncOk ? undefined : errorFor('remote-rsync')))
}
