import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildSystemSshArgv,
  createSystemSshRunner,
  DEFAULT_SSH_TIMEOUT_MS
} from './system-ssh-runner'

const fakeSsh = fileURLToPath(new URL('./__fixtures__/fake-ssh.sh', import.meta.url))
const endpoint = {
  host: 'devbox.example.test',
  port: 2222,
  username: 'alice',
  knownHostsFile: '/tmp/devbox-known_hosts',
  extraOptions: ['IdentityFile=/tmp/id_ed25519', 'LogLevel=ERROR']
} as const

describe('buildSystemSshArgv', () => {
  it('builds hardened argv without joining command text into a shell string', () => {
    const command = `printf '%s' "$HOME"; echo 'hello world'`
    const args = buildSystemSshArgv(endpoint, command)

    expect(args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      `ConnectTimeout=${DEFAULT_SSH_TIMEOUT_MS / 1000}`,
      '-o',
      'UserKnownHostsFile=/tmp/devbox-known_hosts',
      '-o',
      'IdentityFile=/tmp/id_ed25519',
      '-o',
      'LogLevel=ERROR',
      '-p',
      '2222',
      '--',
      'alice@devbox.example.test',
      command
    ])
  })

  it('adds a forced PTY without changing the pinned endpoint options', () => {
    const args = buildSystemSshArgv(endpoint, "tmux new-session -A -s 'devbox-roam-main'", undefined, { pty: true })
    expect(args[0]).toBe('-t')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('UserKnownHostsFile=/tmp/devbox-known_hosts')
    expect(args.at(-2)).toBe('alice@devbox.example.test')
    expect(args.at(-1)).toContain('tmux new-session')
  })

  it('adds remote forwards without clearing command-line forwarding', () => {
    const args = buildSystemSshArgv(endpoint, 'exec tmux attach', undefined, {
      pty: true,
      remoteForwards: ['/tmp/devbox.sock:127.0.0.1:53692']
    })
    expect(args).toContain('ExitOnForwardFailure=no')
    expect(args).not.toContain('ClearAllForwardings=yes')
    expect(args).toContain('-R')
    expect(args).toContain('/tmp/devbox.sock:127.0.0.1:53692')
  })

  it('rejects whitespace and NUL bytes in remote forwards', () => {
    expect(() => buildSystemSshArgv(endpoint, 'exec tmux attach', undefined, {
      remoteForwards: ['remote path:127.0.0.1:1']
    })).toThrow('must not contain whitespace')
    expect(() => buildSystemSshArgv(endpoint, 'printf \0')).toThrow('must not contain NUL')
  })
})

describe('createSystemSshRunner', () => {
  it('returns stdout from a command and streams a script to bash -s', async () => {
    const runner = createSystemSshRunner(endpoint, { sshBinary: fakeSsh })

    await expect(runner.command('printf command')).resolves.toBe('command-output\n')
    await expect(runner.script('printf script')).resolves.toBe('script-output\n')
  })

  it('includes stderr and the exit code for a failed command', async () => {
    const runner = createSystemSshRunner(
      { ...endpoint, host: 'fail.example' },
      { sshBinary: fakeSsh }
    )

    await expect(runner.command('printf failure')).rejects.toMatchObject({
      message: 'Devbox SSH operation failed (exit 23): fake ssh connection failure',
      exitCode: 23,
      stderr: 'fake ssh connection failure\n'
    })
  })

  it('kills a timed-out child process', async () => {
    const runner = createSystemSshRunner(endpoint, { sshBinary: fakeSsh })
    const startedAt = Date.now()

    await expect(runner.command('hang', 100)).rejects.toMatchObject({
      timedOut: true,
      message: expect.stringContaining('timed out after 100ms')
    })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})
