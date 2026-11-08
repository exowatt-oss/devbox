import type { DevboxPreflightCheck, DevboxPreflightResult } from '../core/devbox-preflight'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { commandExecFileAsync } from '../shared/exec'

export type SshConfigProbe = (args: readonly string[]) => Promise<string>

const defaultProbe: SshConfigProbe = async (args) => (await commandExecFileAsync('ssh', args)).stdout

/**
 * Mutagen's daemon and the rsync classes run the user's plain `ssh user@host`,
 * so a proxied profile also needs `host` to resolve to a ProxyCommand in the
 * user's own ssh config.
 * Devbox's own ssh spawns pass the profile ProxyCommand explicitly.
 */
export async function checkSshProxyRoute(
  profile: DevboxProfileV1,
  probe: SshConfigProbe = defaultProbe
): Promise<DevboxPreflightCheck | undefined> {
  const { identity, proxyCommand } = profile.sshTarget
  if (proxyCommand === undefined) {return undefined}
  let configured: string | undefined
  try {
    const output = await probe(['-G', '-p', String(identity.port), '--', `${identity.username}@${identity.host}`])
    configured = /^proxycommand\s+(.+)$/imu.exec(output)?.[1]?.trim()
  } catch {
    configured = undefined
  }
  if (configured && configured.toLowerCase() !== 'none') {
    return { id: 'ssh-proxy-route', status: 'pass', remediation: '', blocking: true, details: { profileProxyCommand: proxyCommand, sshConfigProxyCommand: configured } }
  }
  return {
    id: 'ssh-proxy-route',
    status: 'fail',
    remediation: `Mutagen syncs over your own ssh config: add a Host ${identity.host} block with "ProxyCommand ${proxyCommand}" to ~/.ssh/config, then rerun preflight.`,
    blocking: true,
    details: { profileProxyCommand: proxyCommand }
  }
}

export function withSshProxyRoute(result: DevboxPreflightResult, check: DevboxPreflightCheck | undefined): DevboxPreflightResult {
  if (!check || result.status === 'cancelled') {return result}
  const failed = check.status !== 'pass'
  return {
    ...result,
    status: failed ? 'blocked' : result.status,
    checks: [...result.checks, check],
    blockers: failed ? [...result.blockers, check] : result.blockers,
    ...(failed && result.blockedReason === undefined ? { blockedReason: 'ssh-proxy-route-missing' as const } : {})
  }
}
