import { hostname, networkInterfaces, userInfo } from 'node:os'
import type { SshEndpoint } from '../shared/ssh-runner-types'
import { hasProxyCommandOption } from './ssh-proxy'

export type LocalSshEndpointProbe = {
  username: string
  hostname: string
  addresses: readonly string[]
}

export function isLocalSshEndpoint(
  endpoint: SshEndpoint,
  probe?: LocalSshEndpointProbe
): boolean {
  // A ProxyCommand always reaches another machine (e.g. a woken cloud box).
  if (process.env.DEVBOX_FORCE_REMOTE === '1' || hasProxyCommandOption(endpoint.extraOptions)) {
    return false
  }
  const observed = probe ?? readLocalSshEndpointProbe()
  if (endpoint.username !== observed.username) {
    return false
  }
  const localHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    observed.hostname,
    observed.hostname.split('.')[0],
    ...observed.addresses
  ].map((value) => value.toLowerCase()))
  return localHosts.has(endpoint.host.toLowerCase())
}

function readLocalSshEndpointProbe(): LocalSshEndpointProbe {
  const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address)
  )
  return { username: userInfo().username, hostname: hostname(), addresses }
}
