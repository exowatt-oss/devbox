import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVBOX_WORKSPACE_HANDLERS, resolveLocalPath } from './workspace-handlers'
import { CliArgumentError } from './args'
import type { HandlerContext } from './handlers'
import type { DevboxServiceLike } from './operations'
import { homedir } from 'node:os'

function result(status: 'ready' | 'blocked' | 'failed' = 'ready') {
  return {
    mode: 'init' as const,
    profileId: 'work',
    host: 'devbox.example.com',
    port: 22,
    user: 'sample',
    localRoot: '/workspace/work',
    remoteRoot: '/home/sample/work',
    fingerprint: null,
    steps: [{ id: 'profile', status: 'ok' as const, detail: 'saved' }],
    status,
    pair: null,
    mutagen: null,
    nextSteps: []
  }
}

function context(service: DevboxServiceLike, flags: Record<string, string | boolean>, json = true): HandlerContext {
  return { service, flags: new Map(Object.entries(flags)), cwd: '/workspace', json }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('workspace CLI handlers', () => {
  it('maps init defaults, path expansion, and safety flags', async () => {
    const service = { initWorkspace: vi.fn(async () => result()) } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_WORKSPACE_HANDLERS.init!(context(service, {
      host: 'devbox.example.com',
      user: 'sample',
      'local-root': '~/x',
      'no-service': true,
      'adopt-remote': true,
      yes: true
    }))
    expect(service.initWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      host: 'devbox.example.com',
      port: 22,
      user: 'sample',
      localRoot: resolveLocalPath('~/x', '/workspace'),
      service: false,
      pair: true,
      adoptRemote: true
    }), undefined)
    expect(resolveLocalPath('relative', '/workspace')).toBe('/workspace/relative')
    expect(resolveLocalPath('~/x', '/workspace')).toBe(`${homedir()}/x`)
  })

  it('passes a validated --proxy-command to init and connect, absent when not given', async () => {
    const service = { initWorkspace: vi.fn(async () => result()), connectWorkspace: vi.fn(async () => result()) } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const proxy = '/Users/u/.local/bin/devbox proxy'
    await DEVBOX_WORKSPACE_HANDLERS.init!(context(service, { host: 'devbox', user: 'alice', 'local-root': '/w', 'remote-root': '/home/alice/w', 'proxy-command': proxy, yes: true }))
    await DEVBOX_WORKSPACE_HANDLERS.connect!(context(service, { host: 'devbox', user: 'alice', 'remote-root': '/home/alice/w', 'proxy-command': proxy, yes: true }))
    await DEVBOX_WORKSPACE_HANDLERS.init!(context(service, { host: 'h', user: 'u', 'local-root': '/w', yes: true }))
    expect(service.initWorkspace).toHaveBeenNthCalledWith(1, expect.objectContaining({ host: 'devbox', proxyCommand: proxy }), undefined)
    expect(service.connectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ proxyCommand: proxy }), undefined)
    expect(vi.mocked(service.initWorkspace!).mock.calls[1]![0]).not.toHaveProperty('proxyCommand')
    await expect(DEVBOX_WORKSPACE_HANDLERS.init!(context(service, { host: 'h', user: 'u', 'local-root': '/w', 'proxy-command': true }))).rejects.toThrow('--proxy-command requires a command')
  })

  it('maps connect and sets a blocked exit code', async () => {
    const service = { connectWorkspace: vi.fn(async () => result('blocked')) } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_WORKSPACE_HANDLERS.connect!(context(service, {
      host: 'devbox.example.com', user: 'sample', 'remote-root': '/home/sample/work', 'local-root': 'spoke',
      'allow-non-empty-local': true, 'no-pair': true
    }))
    expect(service.connectWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      remoteRoot: '/home/sample/work',
      localRoot: '/workspace/spoke',
      allowNonEmptyLocal: true,
      pair: false
    }), undefined)
    expect(process.exitCode).toBe(1)
  })

  it('validates absolute remote and shell paths and includes usage', async () => {
    const service = { initWorkspace: vi.fn(async () => result()) } as unknown as DevboxServiceLike
    const run = (flags: Record<string, string | boolean>) => DEVBOX_WORKSPACE_HANDLERS.init!(context(service, flags))
    await expect(run({ host: 'h', user: 'u', 'local-root': '/local', 'remote-root': 'relative' })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('Usage: devbox init') })
    await expect(run({ host: 'h', user: 'u', 'local-root': '/local', 'shell-dir': 'relative' })).rejects.toBeInstanceOf(CliArgumentError)
  })

  it('reports missing workspace flags with a command usage', async () => {
    const service = { initWorkspace: vi.fn(async () => result()) } as unknown as DevboxServiceLike
    await expect(DEVBOX_WORKSPACE_HANDLERS.init!(context(service, {}))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Usage: devbox init')
    })
    expect(service.initWorkspace).not.toHaveBeenCalled()
  })

  it('only passes bootstrap progress in human mode', async () => {
    const service = { initWorkspace: vi.fn(async (_input, progress) => {
      progress?.({ id: 'local-root', status: 'ok', detail: 'created' })
      return result()
    }) } as unknown as DevboxServiceLike
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await DEVBOX_WORKSPACE_HANDLERS.init!({
      ...context(service, { host: 'h', user: 'u', 'local-root': '/local' }, false),
      presentation: { width: 80, env: { TERM: 'dumb' }, isTTY: false }
    })
    expect(service.initWorkspace).toHaveBeenCalledWith(expect.anything(), expect.any(Function))
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('local-root'))

    stderr.mockClear()
    await DEVBOX_WORKSPACE_HANDLERS.init!({
      ...context(service, { host: 'h', user: 'u', 'local-root': '/local' }, true),
      presentation: { width: 80, env: { TERM: 'dumb' }, isTTY: false }
    })
    expect(service.initWorkspace).toHaveBeenLastCalledWith(expect.anything(), undefined)
    expect(stderr).not.toHaveBeenCalled()
  })

  it('reports unavailable init service', async () => {
    await expect(DEVBOX_WORKSPACE_HANDLERS.init!(context({} as DevboxServiceLike, {
      host: 'h', user: 'u', 'local-root': '/local'
    }))).rejects.toThrow('devbox init is unavailable')
  })
})
