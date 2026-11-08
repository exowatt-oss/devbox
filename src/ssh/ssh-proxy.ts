/**
 * Optional per-profile OpenSSH ProxyCommand (for example the proxy-powered host
 * `devbox proxy` helper that wakes a box and pipes to its current address).
 *
 * The profile host stays the stable alias (e.g. `devbox`); every Devbox ssh
 * spawn adds `ProxyCommand=<cmd>` and pins `HostKeyAlias=<known_hosts token>`
 * so StrictHostKeyChecking=yes keeps verifying the pinned key through the
 * proxy, whatever the user's own ssh config says about HostKeyAlias.
 */

/** True when the value is a usable ProxyCommand: non-empty, no NUL, CR or LF. */
export function isValidDevboxProxyCommand(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000') && !/[\r\n]/u.test(value)
}

/** Validates and normalizes (trims) a ProxyCommand, throwing a plain Error otherwise. */
export function normalizeDevboxProxyCommand(value: string): string {
  if (!isValidDevboxProxyCommand(value)) {
    throw new Error('SSH proxy command must be non-empty and must not contain NUL or newlines')
  }
  return value.trim()
}

/** The known_hosts host token OpenSSH uses for this endpoint (`host` or `[host]:port`). */
export function knownHostsToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Extra `-o` options for a proxied endpoint; empty when no proxy command is set. */
export function proxySshOptions(host: string, port: number, proxyCommand: string | undefined): string[] {
  if (proxyCommand === undefined) {
    return []
  }
  return [`ProxyCommand=${normalizeDevboxProxyCommand(proxyCommand)}`, `HostKeyAlias=${knownHostsToken(host, port)}`]
}

/** True when the endpoint's extra ssh options route through a ProxyCommand. */
export function hasProxyCommandOption(options: readonly string[] | undefined): boolean {
  return (options ?? []).some((option) => /^proxycommand[=\s]/iu.test(option))
}
