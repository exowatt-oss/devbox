import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliArgumentError } from './args'
import type { HandlerContext } from './handlers'
import type { DevboxServiceLike } from './operations'
import { createSyncNowHandler, syncNowExitCode, syncSelection, type SyncNowHandlerIo } from './sync-now-handler'
import type { SyncNowEvent, SyncNowRendererOptions, SyncNowResult } from './sync-now-types'

const result = (overrides: Partial<SyncNowResult> = {}): SyncNowResult => ({
  ok: true, startedAt: 1, elapsedMs: 2, machines: [], syncedCount: 1, skippedCount: 1, failedCount: 0, interrupted: false, ...overrides
})

function setup(options: { isTTY?: boolean; value?: SyncNowResult; waitForAbort?: boolean } = {}) {
  const rendered: { options: SyncNowRendererOptions; events: SyncNowEvent[]; closed: number }[] = []
  let interrupt: () => void = () => undefined
  const io: SyncNowHandlerIo = {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn(), isTTY: options.isTTY ?? false },
    onInterrupt: (handler) => { interrupt = handler; return () => { interrupt = () => undefined } },
    hardExit: vi.fn(),
    createRenderer: (rendererOptions) => {
      const entry = { options: rendererOptions, events: [] as SyncNowEvent[], closed: 0 }
      rendered.push(entry)
      return { onEvent: (event) => entry.events.push(event), close: () => { entry.closed += 1 } }
    }
  }
  const syncNow = vi.fn<NonNullable<DevboxServiceLike['syncNow']>>(async (_options, listener, signal) => {
    listener({ type: 'warning', message: 'hello' })
    if (options.waitForAbort) {await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))}
    const value = signal?.aborted ? result({ interrupted: true, ok: false }) : options.value ?? result()
    listener({ type: 'finished', result: value })
    return value
  })
  const context = (flags: Record<string, string | boolean>, json = false, extra: Partial<HandlerContext> = {}): HandlerContext => ({
    flags: new Map(Object.entries(flags)),
    service: { syncNow } as unknown as DevboxServiceLike,
    cwd: '/',
    json,
    presentation: { env: {}, isTTY: false, columns: 100 },
    ...extra
  })
  return { io, rendered, syncNow, context, handler: createSyncNowHandler(io), interrupt: () => interrupt() }
}

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('db sync handler', () => {
  it('syncs every machine by default with the 900 s cap and a plain renderer off a TTY', async () => {
    const { handler, context, syncNow, rendered } = setup()
    await handler(context({}))
    expect(syncNow.mock.calls[0]![0]).toEqual({ selection: {}, wake: false, timeoutMs: 900_000 })
    expect(rendered).toHaveLength(1)
    expect(rendered[0]!.options.mode).toBe('plain')
    expect(rendered[0]!.events.map((event) => event.type)).toEqual(['warning', 'finished'])
    expect(rendered[0]!.closed).toBeGreaterThan(0)
    expect(process.exitCode).toBe(0)
  })

  it('uses the live renderer on a TTY unless --plain, and passes --wake/--timeout/--device', async () => {
    const live = setup({ isTTY: true })
    await live.handler(live.context({ wake: true, timeout: '0', device: 'aws', profile: 'aws' }))
    expect(live.rendered[0]!.options.mode).toBe('live')
    expect(live.syncNow.mock.calls[0]![0]).toEqual({ selection: { device: 'aws' }, wake: true, timeoutMs: 0 })
    const plain = setup({ isTTY: true })
    await plain.handler(plain.context({ plain: true, profile: 'roam' }))
    expect(plain.rendered[0]!.options.mode).toBe('plain')
    expect(plain.syncNow.mock.calls[0]![0].selection).toEqual({ profile: 'roam' })
  })

  it('prints the JSON envelope with no renderer under --json', async () => {
    const { handler, context, rendered } = setup({ value: result({ ok: false, failedCount: 1 }) })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await handler(context({}, true))
    expect(rendered).toHaveLength(0)
    const envelope = JSON.parse(String(log.mock.calls[0]![0])) as { command: string; ok: boolean; result: SyncNowResult }
    expect(envelope).toMatchObject({ command: 'sync', ok: true, result: { failedCount: 1, ok: false } })
    expect(process.exitCode).toBe(1)
  })

  it('stops gracefully on the first interrupt (exit 130) and hard-exits on the second', async () => {
    const { handler, context, io, interrupt, rendered } = setup({ waitForAbort: true })
    const pending = handler(context({}))
    await vi.waitFor(() => expect(rendered[0]?.events.length).toBe(1))
    interrupt()
    await pending
    expect(process.exitCode).toBe(130)
    expect(io.hardExit).not.toHaveBeenCalled()

    const second = setup({ waitForAbort: true })
    second.syncNow.mockImplementationOnce(async () => {
      second.interrupt()
      second.interrupt()
      return result({ interrupted: true })
    })
    await second.handler(second.context({}))
    expect(second.io.hardExit).toHaveBeenCalledWith(130)
    expect(second.io.stderr.write).toHaveBeenCalledWith('db sync stopped at once (second Ctrl-C); the sessions it resumed are being paused in the background\n')
  })

  it('rejects positional arguments and services without sync', async () => {
    const { handler, context } = setup()
    await expect(handler(context({}, false, { positionalArgs: ['workstation'] }))).rejects.toBeInstanceOf(CliArgumentError)
    await expect(handler({ ...context({}), service: {} as DevboxServiceLike })).rejects.toThrow('devbox sync is unavailable')
  })

  it('maps results to exit codes and flags to a selection', () => {
    expect(syncNowExitCode({ interrupted: false, failedCount: 0 })).toBe(0)
    expect(syncNowExitCode({ interrupted: false, failedCount: 2 })).toBe(1)
    expect(syncNowExitCode({ interrupted: true, failedCount: 2 })).toBe(130)
    expect(syncSelection(new Map())).toEqual({})
    expect(syncSelection(new Map([['profile', 'roam']]))).toEqual({ profile: 'roam' })
    expect(syncSelection(new Map([['profile', 'aws'], ['device', 'aws']]))).toEqual({ device: 'aws' })
  })
})
