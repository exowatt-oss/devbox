import { afterEach, describe, expect, it, vi } from 'vitest'
import { stripAnsi, visibleWidth } from './presentation'
import { main, scheduleExitGuard } from './index'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DEVBOX_PROFILE
  process.exitCode = undefined
  vi.useRealTimers()
})

describe('standalone CLI entry', () => {
  it('exposes a short unref exit guard seam for CLI teardown', () => {
    vi.useFakeTimers()
    const exit = vi.fn(() => undefined as never)
    scheduleExitGuard(7, exit)
    vi.advanceTimersByTime(249)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exit).toHaveBeenCalledWith(7)
  })

  it('allows help and version with an empty environment', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await main(['--help'])
    await main(['--version'])
    expect(output.mock.calls.map(([line]) => String(line)).join('\n')).toContain('Devbox standalone CLI')
    expect(stdout.mock.calls.map(([line]) => String(line)).join('\n')).toContain('devbox 0.1.8')
  })

  it('prints usage and the command list for an unknown command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const makeService = vi.fn(() => { throw new Error('must not construct') })
    await main(['wat'], '/tmp', makeService)
    const output = error.mock.calls.flat().map(String).join('\n')
    expect(makeService).not.toHaveBeenCalled()
    expect(output).toContain('Unknown command: wat')
    expect(output).toContain('Usage: devbox <command> [flags]')
    expect(output).toContain('devbox status')
    expect(process.exitCode).toBe(2)
  })

  it('runs `sync` across every machine: no default-profile narrowing, boolean --wake/--plain, --device kept', async () => {
    process.env.DEVBOX_PROFILE = 'no-such-profile'
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const syncNow = vi.fn(async () => ({ ok: true, startedAt: 0, elapsedMs: 0, machines: [], syncedCount: 0, skippedCount: 0, failedCount: 0, interrupted: false }))
    const makeService = () => ({ syncNow }) as never
    await main(['sync', '--json'], '/tmp', makeService, { exitGuard: () => undefined })
    await main(['sync', '--device', 'aws', '--wake', '--plain', '--timeout', '30', '--json'], '/tmp', makeService, { exitGuard: () => undefined })
    expect(syncNow.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { selection: {}, wake: false, timeoutMs: 900_000 },
      { selection: { device: 'aws' }, wake: true, timeoutMs: 30_000 }
    ])
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ command: 'sync', ok: true })
    expect(process.exitCode).toBe(0)
    log.mockClear()
    await main(['help', 'sync'], '/tmp', () => undefined as never, { presentation: { env: {}, isTTY: false, columns: 200 } })
    expect(stripAnsi(log.mock.calls.flat().map(String).join('\n'))).toContain('Sync every machine now (live view; skips unreachable or hung machines)')
  })

  it('renders wide generic help as a bounded command table', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await main(['--help'], '/tmp', () => undefined as never, {
      presentation: { width: 120, env: { TERM: 'xterm-256color' }, isTTY: false }
    })
    const text = output.mock.calls.flat().map(String).join('\n')
    expect(text).toContain('Devbox standalone CLI')
    expect(text).toContain('Everyday commands')
    expect(text).toContain('COMMAND')
    expect(text).toContain('SUMMARY')
    expect(text).toContain('devbox status')
    expect(text).toContain('devbox profile create')
    expect(text).toContain('devbox profile credentials enable')
    expect(text).toContain('devbox profile paste enable')
    expect(text).not.toContain('devbox profile create --profile <id> --host')
    expect(text).toContain('Global flags: --help --json --version')
    expect(text).toContain('AGENT-SETUP.md')
    expect(text).not.toContain('\u001b[')
    expect(text.split('\n').every((line) => visibleWidth(line) <= 120)).toBe(true)
  })

  it('stacks narrow generic help and keeps every line within the terminal width', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await main(['--help'], '/tmp', () => undefined as never, {
      presentation: { width: 64, env: { TERM: 'xterm-256color' }, isTTY: false }
    })
    const text = output.mock.calls.flat().map(String).join('\n')
    expect(text).not.toContain('COMMAND')
    expect(text).toContain('devbox pair\n    Pair and start a Devbox profile')
    expect(text).toContain('devbox shell\n    Manage persistent tmux shells on the Devbox host')
    expect(text).not.toContain('devbox pair [--profile <id>] [--json]')
    expect(text.split('\n').every((line) => visibleWidth(line) <= 64)).toBe(true)
  })

  it('keeps generic help paths and summaries readable at common widths', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    for (const width of [60, 80, 100, 120]) {
      output.mockClear()
      await main(['--help'], '/tmp', () => undefined as never, {
        presentation: { width, env: { TERM: 'xterm-256color' }, isTTY: false }
      })
      const text = output.mock.calls.flat().map(String).join('\n')
      expect(text).toContain('devbox shell')
      if (width >= 96) {
        expect(text).toContain('devbox profile create')
      }
      expect(text.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
      if (width < 96) {
        expect(text).not.toContain('devbox shell [<id-or-name>]')
      }
    }
  })

  it('wraps detailed usage, notes, and examples without replacing the full command text', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await main(['help', 'shell'], '/tmp', () => undefined as never, {
      presentation: { width: 60, env: { TERM: 'xterm-256color' }, isTTY: false }
    })
    const text = output.mock.calls.flat().map(String).join('\n')
    expect(text).toContain('devbox shell [<id-or-name>] [--no-reconnect]')
    expect(text).toContain('reconnect --all')
    expect(text).toContain('rm --unattached')
    expect(text).toContain('devbox shell resume')
    expect(text).toContain('Detach with Ctrl-b d')
    expect(text).toContain('devbox shell rm agents')
    expect(text.split('\n').every((line) => visibleWidth(line) <= 60)).toBe(true)
  })

  it('renders a focused subcommand listing for bare mutagen help', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await main(['help', 'mutagen'], '/tmp', () => undefined as never, {
      presentation: { width: 80, env: { TERM: 'dumb' }, isTTY: false }
    })
    const text = output.mock.calls.flat().map(String).join('\n')
    expect(text).toContain('Devbox mutagen')
    expect(text).toContain('Usage: devbox mutagen <command> [flags]')
    expect(text).toContain('devbox mutagen status')
    expect(text).toContain('devbox mutagen spokes')
    expect(text).not.toContain('devbox profile create')
    expect(text.split('\n').every((line) => visibleWidth(line) <= 80)).toBe(true)
  })

  it('uses semantic colour only for an explicitly TTY presentation', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await main(['help', 'shell'], '/tmp', () => undefined as never, {
      presentation: { width: 120, env: { TERM: 'xterm-256color' }, isTTY: true }
    })
    const colored = output.mock.calls.flat().map(String).join('\n')
    expect(colored).toContain('\u001b[')
    expect(colored).toContain('Summary:')
    expect(colored).toContain('Usage:')
    expect(colored).toContain('Notes:')
    expect(colored).toContain('Examples:')

    output.mockClear()
    await main(['help', 'shell'], '/tmp', () => undefined as never, {
      presentation: { width: 120, env: { TERM: 'xterm-256color', NO_COLOR: '' }, isTTY: true }
    })
    const noColor = output.mock.calls.flat().map(String).join('\n')
    expect(noColor).not.toContain('\u001b[')
    expect(stripAnsi(noColor)).toBe(noColor)
  })
})
