import { describe, expect, it, vi } from 'vitest'

vi.mock('node:os', () => ({
  networkInterfaces: () => ({ en0: [undefined, { address: '192.0.2.1' }] }),
  hostname: () => 'Devbox-Mac'
}))

import { assertHubIsNotLocal, collectLocalHostFacts, isLocalHost, type LocalHostFacts } from './hub-local-guard'

const facts: LocalHostFacts = {
  hostname: 'Devbox-Mac',
  addresses: ['192.0.2.10', 'fe80::1']
}

describe('hub local guard', () => {
  it('recognizes local aliases, loopback values, hostname variants, and interfaces', () => {
    for (const host of ['', 'localhost', 'localhost.localdomain', '127.0.0.1', '127.99.1.2', '::1', '[::1]', '0.0.0.0', '::', 'devbox-mac', 'devbox-mac.local', 'DEVBOX-MAC.', 'devbox-mac.local.', '192.0.2.10', '[FE80::1]', '[FE80::1%en0]', 'FE80::1%EN0']) {
      expect(isLocalHost(host, facts), host).toBe(true)
    }
  })

  it('tolerates undefined interface entries while collecting facts', () => {
    expect(() => collectLocalHostFacts()).not.toThrow()
    expect(collectLocalHostFacts().addresses).toContain('192.0.2.1')
  })

  it('does not classify ordinary remote hosts as local', () => {
    expect(isLocalHost('203.0.113.10', facts)).toBe(false)
    expect(isLocalHost('devbox.example', facts)).toBe(false)
    expect(isLocalHost('fe80::2', facts)).toBe(false)
  })

  it('reports the stable operation conflict field', () => {
    try {
      assertHubIsNotLocal('localhost', facts)
      throw new Error('expected a local-host conflict')
    } catch (error) {
      expect(error).toMatchObject({ code: 'operation_conflict', context: { field: 'hub-is-local' } })
    }
    expect(() => assertHubIsNotLocal('hub.example', facts)).not.toThrow()
  })
})
