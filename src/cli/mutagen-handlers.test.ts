import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliArgumentError, parseArgs, validateCommandAndFlags } from './args'
import { DEVBOX_MUTAGEN_HANDLERS } from './mutagen-handlers'
import { main } from './index'
import { COMMAND_SPECS } from './specs'
import type { HandlerContext } from './handlers'
import type { DevboxServiceLike } from './operations'

function context(service: DevboxServiceLike, flags: Record<string, string | boolean>, json = true): HandlerContext {
  return {
    service,
    flags: new Map(Object.entries(flags)),
    cwd: '/workspace',
    json
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('Mutagen CLI handlers', () => {
  it('maps status options, reports violations, and emits a JSON envelope', async () => {
    const service = {
      mutagenStatus: vi.fn(async () => ({
        profileId: null,
        binary: { path: null, version: null, dataDirectory: '/tmp/mutagen' },
        service: { installed: false },
        daemon: { running: true },
        sessions: [],
        topology: { verdict: 'violation', violations: ['spoke chained to spoke'] },
        hub: null,
        hints: []
      }))
    } as unknown as DevboxServiceLike
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_MUTAGEN_HANDLERS['mutagen status']!(context(service, { 'no-remote': true }))
    expect(service.mutagenStatus).toHaveBeenCalledWith(undefined, { remote: false })
    expect(process.exitCode).toBe(1)
    const envelope = JSON.parse(String(output.mock.calls[0]?.[0])) as { command: string; ok: boolean; result: unknown }
    expect(envelope).toMatchObject({ command: 'mutagen status', ok: true })
    expect(envelope.result).toBeTruthy()
  })

  it('does not mark status unhealthy when the daemon probe is unknown', async () => {
    const service = {
      mutagenStatus: vi.fn(async () => ({
        service: { installed: true },
        daemon: { running: false, origin: 'unknown' },
        topology: { verdict: 'no-sessions', violations: [] },
        sessions: [], hints: []
      }))
    } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_MUTAGEN_HANDLERS['mutagen status']!(context(service, {}))
    expect(process.exitCode).toBe(0)
  })

  it('maps service actions and uninstall to delete', async () => {
    const service = { mutagenServiceAction: vi.fn(async () => ({ action: 'delete', via: 'mutagen-cli', service: {}, daemon: {} })) } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_MUTAGEN_HANDLERS['mutagen uninstall']!(context(service, {}))
    expect(service.mutagenServiceAction).toHaveBeenCalledWith('delete')
  })

  it('runs mutagen resume and flush as a one-shot db sync of the profile, never a live resume', async () => {
    const result = { ok: true, startedAt: 0, elapsedMs: 0, machines: [], syncedCount: 0, skippedCount: 0, failedCount: 0, interrupted: false }
    const syncNow = vi.fn(async () => result)
    const mutagenSessionAction = vi.fn()
    const service = { syncNow, mutagenSessionAction } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    for (const verb of ['resume', 'flush']) {
      await DEVBOX_MUTAGEN_HANDLERS[`mutagen ${verb}`]!(context(service, { profile: 'devbox', device: 'devbox' }))
    }
    expect(syncNow).toHaveBeenCalledTimes(2)
    for (const call of syncNow.mock.calls as unknown as [{ selection: unknown }][]) {expect(call[0].selection).toEqual({ profile: 'devbox' })}
    expect(mutagenSessionAction).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('defaults logs to 80 and rejects zero', async () => {
    const service = { mutagenLogs: vi.fn(async () => ({ logPath: '/tmp/log', exists: false, lines: [] })) } as unknown as DevboxServiceLike
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await DEVBOX_MUTAGEN_HANDLERS['mutagen logs']!(context(service, {}))
    expect(service.mutagenLogs).toHaveBeenCalledWith(80)
    await expect(DEVBOX_MUTAGEN_HANDLERS['mutagen logs']!(context(service, { lines: '0' }))).rejects.toThrow('--lines must be a positive integer')
    await expect(DEVBOX_MUTAGEN_HANDLERS['mutagen logs']!(context(service, { lines: '-1' }))).rejects.toBeInstanceOf(CliArgumentError)
    await expect(DEVBOX_MUTAGEN_HANDLERS['mutagen logs']!(context(service, { lines: '1.5' }))).rejects.toBeInstanceOf(CliArgumentError)
  })

  it('lists hub commands in help and shows init notes', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await main(['--help'])
    await main(['help', 'init'])
    const text = output.mock.calls.flat().map(String).join('\n')
    expect(text).toContain('devbox init')
    expect(text).toContain('devbox connect')
    expect(text).toContain('devbox mutagen status')
    expect(text).toContain('remote host + remote root becomes the hub')
    const normalized = text.replace(/\s+/gu, ' ')
    expect(normalized).toContain('sanitized to [A-Za-z0-9._-]')
    expect(normalized).toContain('--fingerprint <SHA256:fingerprint>')
    await main(['help', 'mutagen', 'status'])
    await main(['help', 'mutagen', 'setup'])
    await main(['help', 'mutagen', 'logs'])
    const hubText = output.mock.calls.flat().map(String).join('\n')
    const normalizedHubText = hubText.replace(/\s+/gu, ' ')
    expect(normalizedHubText).toContain('sessions (all Devbox-owned)')
    expect(normalizedHubText).toContain('Registers the spoke only when a profile is selected and --no-remote is not passed.')
    expect(normalizedHubText).toContain('--lines must be a positive integer')
  })

  it('parses hub command booleans and paths and rejects missing values', () => {
    const parsed = parseArgs(['mutagen', 'logs', '--lines', '200', '--no-service'])
    expect(parsed.commandPath).toEqual(['mutagen', 'logs'])
    expect(parsed.flags.get('lines')).toBe('200')
    expect(parseArgs(['init', '--no-service']).flags.get('no-service')).toBe(true)
    expect(() => {
      const missing = parseArgs(['init', '--remote-root'])
      validateCommandAndFlags(COMMAND_SPECS, missing)
    }).toThrow('Flag --remote-root requires a value.')
  })

  it('rejects unavailable service methods', async () => {
    await expect(DEVBOX_MUTAGEN_HANDLERS['mutagen status']!(context({} as DevboxServiceLike, {}))).rejects.toThrow('devbox mutagen status is unavailable')
  })
})
