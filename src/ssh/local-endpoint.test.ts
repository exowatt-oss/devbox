import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLocalSshEndpoint } from './local-endpoint'

const base = { host: 'Hub.Example', port: 22, username: 'alice' }
const probe = { username: 'alice', hostname: 'Hub.Example.local', addresses: ['192.0.2.11', 'FE80::1'] }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isLocalSshEndpoint', () => {
  it('recognizes loopback, hostname, short hostname, and interface addresses', () => {
    expect(isLocalSshEndpoint({ ...base, host: 'LOCALHOST' }, probe)).toBe(true)
    expect(isLocalSshEndpoint({ ...base, host: '192.0.2.11' }, probe)).toBe(true)
    expect(isLocalSshEndpoint({ ...base, host: 'fe80::1' }, probe)).toBe(true)
    expect(isLocalSshEndpoint({ ...base, host: 'hub.example.local' }, probe)).toBe(true)
    expect(isLocalSshEndpoint({ ...base, host: 'HUB' }, probe)).toBe(true)
  })

  it('rejects a different user or host', () => {
    expect(isLocalSshEndpoint({ ...base, username: 'bob' }, probe)).toBe(false)
    expect(isLocalSshEndpoint({ ...base, host: 'other.example' }, probe)).toBe(false)
  })

  it('honours the force-remote escape hatch', () => {
    vi.stubEnv('DEVBOX_FORCE_REMOTE', '1')
    expect(isLocalSshEndpoint({ ...base, host: 'localhost' }, probe)).toBe(false)
  })
})
