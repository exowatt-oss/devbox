import { describe, expect, it } from 'vitest'
import { parseArgs, validateCommandAndFlags } from './args'
import { parseDevboxShellCommand } from './shell-command'
import { COMMAND_SPECS } from './specs'

function command(argv: string[]) {
  const parsed = parseArgs(argv)
  return parseDevboxShellCommand(parsed.positionalArgs ?? [], parsed.flags)
}

describe('devbox shell verb parser', () => {
  it('accepts the bare shell boolean flags at the top-level validator (regression: --unattached demanded a value)', () => {
    for (const argv of [
      ['shell', 'rm', '--unattached'],
      ['shell', 'rm', '--all'],
      ['shell', 'ls', '--json'],
      ['shell', 'reconnect', '--all', '--dry-run'],
      ['shell', 'resume', '--no-reconnect'],
      ['shell', '--no-login-relay']
    ]) {
      const parsed = parseArgs(argv)
      expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed), argv.join(' ')).not.toThrow()
    }
    expect(command(['shell', 'rm', '--unattached'])).toEqual({ verb: 'remove', all: false, unattached: true, allDevices: false })
  })

  it('parses bare attach, new, id/name attach, ls, rm, and rm --all', () => {
    expect(command(['shell'])).toEqual({ verb: 'attach', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'new'])).toEqual({ verb: 'new', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'new', 'agents'])).toEqual({ verb: 'new', name: 'agents', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'new', 'agents', '--cwd', '/home/sample'])).toEqual({ verb: 'new', name: 'agents', cwd: '/home/sample', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', '12'])).toEqual({ verb: 'attach', target: '12', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'agents'])).toEqual({ verb: 'attach', target: 'agents', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'ls'])).toEqual({ verb: 'list' })
    expect(command(['shell', 'rm', '12'])).toEqual({ verb: 'remove', target: '12', all: false, allDevices: false })
    expect(command(['shell', 'rm', 'this'])).toEqual({ verb: 'remove', target: 'this', all: false, allDevices: false })
    expect(command(['shell', 'rm', '--all'])).toEqual({ verb: 'remove', all: true, allDevices: false })
    expect(command(['shell', 'rm', '--unattached'])).toEqual({ verb: 'remove', all: false, unattached: true, allDevices: false })
    expect(command(['shell', 'rm', '--unattached', '--all-devices'])).toEqual({ verb: 'remove', all: false, unattached: true, allDevices: true })
  })

  it('keeps the v0.1.5 flag forms as hidden aliases', () => {
    expect(command(['shell', '--name', 'agents'])).toEqual({ verb: 'attach', target: 'agents', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', '--list'])).toEqual({ verb: 'list' })
    expect(command(['shell', '--kill', '12'])).toEqual({ verb: 'remove', target: '12', all: false, allDevices: false })
    expect(command(['shell', '--kill', 'this'])).toEqual({ verb: 'remove', target: 'this', all: false, allDevices: false })
  })

  it('parses reconnect, resume, and reconnect flags', () => {
    expect(command(['shell', 'resume'])).toEqual({ verb: 'resume', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'resume', '--no-reconnect'])).toEqual({ verb: 'resume', noReconnect: true, noLoginRelay: false })
    expect(command(['shell', 'reconnect'])).toEqual({ verb: 'resume', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'reconnect', '--no-reconnect'])).toEqual({ verb: 'resume', noReconnect: true, noLoginRelay: false })
    expect(command(['shell', 'reconnect', '--no-login-relay'])).toEqual({ verb: 'resume', noReconnect: false, noLoginRelay: true })
    expect(command(['shell', 'reconnect', '--all'])).toEqual({ verb: 'reconnect-all', dryRun: false })
    expect(command(['shell', 'reconnect', '--all', '--dry-run', '--worktree', 'path:/repo'])).toEqual({ verb: 'reconnect-all', dryRun: true, worktree: 'path:/repo' })
    expect(command(['shell', '--no-reconnect'])).toEqual({ verb: 'attach', noReconnect: true, noLoginRelay: false })
  })

  it('parses --run only with new and rejects empty, NUL, multi-line, and oversized commands', () => {
    expect(command(['shell', 'new', 'review', '--cwd', '/srv', '--run', 'opus --session abc'])).toEqual({ verb: 'new', name: 'review', cwd: '/srv', run: 'opus --session abc', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'new', '--run=--weird'])).toEqual({ verb: 'new', run: '--weird', noReconnect: false, noLoginRelay: false })
    expect(command(['shell', 'new', '--run', 'x'.repeat(4096)])).toMatchObject({ run: 'x'.repeat(4096) })
    const parsed = parseArgs(['shell', 'new', 'review', '--run', 'phi --session 01a1'])
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    expect(() => command(['shell', 'new', '--run', ''])).toThrow('--run requires a command.')
    expect(() => command(['shell', 'new', '--run'])).toThrow('--run requires a command.')
    expect(() => command(['shell', 'new', '--run', '   '])).toThrow('--run requires a command.')
    expect(() => command(['shell', 'new', '--run', 'a\0b'])).toThrow('NUL')
    expect(() => command(['shell', 'new', '--run', 'a\nb'])).toThrow('single line')
    expect(() => command(['shell', 'new', '--run', 'a\rb'])).toThrow('single line')
    expect(() => command(['shell', 'new', '--run', 'x'.repeat(4097)])).toThrow('at most 4096 bytes')
    expect(() => command(['shell', 'new', '--run', 'é'.repeat(2049)])).toThrow('at most 4096 bytes')
    for (const argv of [['shell', '--run', 'x'], ['shell', 'agents', '--run', 'x'], ['shell', 'ls', '--run', 'x'], ['shell', 'resume', '--run', 'x'], ['shell', 'reconnect', '--run', 'x'], ['shell', 'rm', '1', '--run', 'x'], ['shell', '--list', '--run', 'x']]) {
      expect(() => command(argv), argv.join(' ')).toThrow("--run is only supported with 'devbox shell new'.")
    }
  })

  it('rejects ambiguous or incomplete verbs', () => {
    expect(() => command(['shell', 'new', 'one', 'two'])).toThrow('Usage: devbox shell new [name]')
    expect(() => command(['shell', '--cwd', '/tmp'])).toThrow('only supported with')
    expect(() => command(['shell', 'ls', '--cwd', '/tmp'])).toThrow('only supported with')
    expect(() => command(['shell', 'rm'])).toThrow('Usage: devbox shell rm')
    expect(() => command(['shell', 'rm', 'one', '--all'])).toThrow('Usage: devbox shell rm')
    expect(() => command(['shell', 'rm', 'this', '--unattached'])).toThrow('Usage: devbox shell rm')
    expect(() => command(['shell', 'rm', '--all', '--unattached'])).toThrow('cannot be combined')
    expect(() => command(['shell', 'rm', '--all', '--all-devices'])).toThrow('Usage: devbox shell rm')
    expect(() => command(['shell', 'rm', '--unattached', '--name', 'one'])).toThrow('cannot be combined')
    expect(() => command(['shell', '--unattached'])).toThrow('Usage: devbox shell rm --unattached')
    expect(() => command(['shell', 'ls', '--unattached'])).toThrow('only supported without')
    expect(() => command(['shell', '--kill'])).toThrow('--kill requires a session name.')
    expect(() => command(['shell', '--list', '--name', 'one'])).toThrow('cannot be combined')
    expect(() => command(['shell', '--list', '--unattached'])).toThrow('cannot be combined')
    expect(() => command(['shell', 'resume', '--dry-run'])).toThrow('Usage: devbox shell')
    expect(() => command(['shell', 'reconnect', '--worktree', 'active'])).toThrow('require')
    expect(() => command(['shell', 'reconnect', '--all', '--no-reconnect'])).toThrow('not supported')
    expect(() => command(['shell', 'ls', '--no-reconnect'])).toThrow('Usage: devbox shell ls')
  })
})
