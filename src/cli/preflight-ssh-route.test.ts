import { describe, expect, it } from 'vitest'
import type { DevboxPreflightResult } from '../core/devbox-preflight'
import type { DevboxProfileV1 } from '../shared/devbox-types'
import { checkSshProxyRoute, withSshProxyRoute } from './preflight-ssh-route'

const PROXY = '/Users/u/.local/bin/devbox proxy'
const profile = (proxyCommand?: string): DevboxProfileV1 => ({
  sshTarget: { targetId: 't', identity: { host: 'devbox', port: 22, username: 'alice', hostKeyFingerprint: 'SHA256:a' }, ...(proxyCommand ? { proxyCommand } : {}) }
}) as unknown as DevboxProfileV1
const ready = { status: 'ready', checks: [], blockers: [] } as unknown as DevboxPreflightResult

describe('ssh proxy route preflight', () => {
  it('is skipped entirely for direct profiles', async () => {
    let probed = false
    expect(await checkSshProxyRoute(profile(), async () => { probed = true; return '' })).toBeUndefined()
    expect(probed).toBe(false)
    expect(withSshProxyRoute(ready, undefined)).toBe(ready)
  })

  it('passes when the user ssh config routes the alias through a ProxyCommand', async () => {
    const calls: (readonly string[])[] = []
    const check = await checkSshProxyRoute(profile(PROXY), async (args) => { calls.push(args); return `user alice\nhostname devbox\nproxycommand ${PROXY}\nhostkeyalias devbox\n` })
    expect(calls).toEqual([['-G', '-p', '22', '--', 'alice@devbox']])
    expect(check).toMatchObject({ id: 'ssh-proxy-route', status: 'pass', details: { sshConfigProxyCommand: PROXY } })
    expect(withSshProxyRoute(ready, check)).toMatchObject({ status: 'ready', blockers: [] })
  })

  it('blocks with a remediation when Mutagen could not reach the alias', async () => {
    for (const probe of [async () => 'hostname devbox\n', async () => 'proxycommand none\n', async () => { throw new Error('ssh missing') }]) {
      const check = await checkSshProxyRoute(profile(PROXY), probe)
      expect(check).toMatchObject({ id: 'ssh-proxy-route', status: 'fail', blocking: true, remediation: expect.stringContaining(`Host devbox block with "ProxyCommand ${PROXY}"`) })
      expect(withSshProxyRoute(ready, check)).toMatchObject({ status: 'blocked', blockedReason: 'ssh-proxy-route-missing', blockers: [check] })
    }
  })
})
