import { networkInterfaces, hostname } from 'node:os'
import { createDevboxError } from '../shared/devbox-errors'

export type LocalHostFacts = {
  hostname: string
  addresses: readonly string[]
}

export function collectLocalHostFacts(): LocalHostFacts {
  const addresses = Object.values(networkInterfaces() ?? {})
    .flatMap((interfaces) => interfaces ?? [])
    .map((entry) => stripAddressDecorations(entry?.address ?? ''))
    .filter((address, index, all) => address.length > 0 && all.indexOf(address) === index)
  return { hostname: hostname(), addresses }
}

export function isLocalHost(host: string, facts: LocalHostFacts): boolean {
  const normalized = normalizeHost(host)
  if (normalized.length === 0 || normalized === 'localhost' || normalized === 'localhost.local' || normalized === 'localhost.localdomain') {
    return true
  }
  if (normalized === '::1' || normalized === '::' || normalized === '0.0.0.0' || isLoopbackIpv4(normalized)) {
    return true
  }
  const hostnameVariants = hostVariants(facts.hostname)
  if (hostVariants(host).some((variant) => hostnameVariants.includes(variant))) {
    return true
  }
  const addresses = facts.addresses.map((address) => normalizeHost(address))
  return addresses.includes(normalized)
}

export function assertHubIsNotLocal(host: string, facts: LocalHostFacts = collectLocalHostFacts()): void {
  if (!isLocalHost(host, facts)) {
    return
  }
  throw createDevboxError('operation_conflict', {
    message: `Devbox never syncs local ↔ local: hub host '${host}' resolves to this machine. Point --host at the remote hub.`,
    context: { field: 'hub-is-local' }
  })
}

function hostVariants(value: string): readonly string[] {
  const normalized = normalizeHost(value)
  const withoutLocal = normalized.endsWith('.local') ? normalized.slice(0, -'.local'.length) : normalized
  return withoutLocal === normalized ? [normalized] : [normalized, withoutLocal]
}

function normalizeHost(value: string): string {
  const stripped = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  return stripAddressDecorations(stripped).replace(/\.+$/, '').toLowerCase()
}

function isLoopbackIpv4(value: string): boolean {
  const octets = value.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.slice(1).every((octet) => /^(?:0|[1-9]?[0-9]|[1-2][0-9]{2})$/.test(octet) && Number(octet) <= 255)
}

function stripAddressDecorations(value: string): string {
  const zoneIndex = value.indexOf('%')
  return (zoneIndex < 0 ? value : value.slice(0, zoneIndex)).replace(/^\[/, '').replace(/\]$/, '')
}
