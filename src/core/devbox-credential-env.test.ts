import { describe, expect, it, vi } from 'vitest'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import {
  buildDevboxCredentialEnvStageScript,
  buildDevboxShellEnvironmentRefreshScript,
  buildDevboxShellSourceCommand,
  parseDevboxEnvFile,
  stageDevboxCredentialEnv
} from './devbox-credential-env'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TOKEN = 'synthetic-credential-value-7f2a'

function temporaryEnvFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'devbox-env-'))
  const path = join(root, 'secrets.env')
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}

describe('credential env-file parser and staging', () => {
  it('accepts comments, blank lines, export prefixes, and CRLF while keeping values exact', () => {
    expect(parseDevboxEnvFile(`\r\n# comment\r\nexport FOO=one two\r\nBAR=${TOKEN}\r\nSPACED= value \r\n`)).toEqual({
      FOO: 'one two',
      BAR: TOKEN,
      SPACED: ' value '
    })
  })

  it('rejects malformed input with the source line number without echoing its value', () => {
    expect(() => parseDevboxEnvFile(`GOOD=yes\nthis is garbage=${TOKEN}\n`, '/tmp/credentials.env')).toThrow(
      'Invalid credential env file /tmp/credentials.env at line 2; expected KEY=VALUE.'
    )
    expect(() => parseDevboxEnvFile(`GOOD=yes\nthis is garbage=${TOKEN}\n`, '/tmp/credentials.env')).not.toThrow(TOKEN)
  })

  it('builds a stdin-only stage script with tmpfs, umask, chmod, and atomic replacement checks', () => {
    const script = buildDevboxCredentialEnvStageScript('roam', { TOKEN })
    expect(script).toContain('umask 077')
    expect(script).toContain("devbox_env_path='/dev/shm/devbox-roam.env'")
    expect(script).toContain('devbox_env_path="$(getconf DARWIN_USER_TEMP_DIR)devbox-roam.env"')
    expect(script).toContain('stat -f -c %T /dev/shm')
    expect(script).toContain('findmnt -n -o FSTYPE --target /dev/shm')
    expect(script).toContain('remote="$devbox_env_path"')
    execFileSync('bash', ['-n'], { input: script })
    expect(script).toContain('stat -c %a')
    expect(script).toContain('stat -f %Lp')
    expect(script).toContain('chmod 600 "$tmp"')
    expect(script).toContain('mv -f "$tmp" "$remote"')
    expect(script).toContain(`TOKEN='${TOKEN}'`)
    expect(script).not.toContain('rm -rf')
  })

  it('streams the local file as SSH script stdin and never includes its value in an SSH command', async () => {
    const path = temporaryEnvFile(`export SMOKE_TOKEN=${TOKEN}\n`)
    const scripts: string[] = []
    const commands: string[] = []
    const runner: DevboxSshRunner = {
      command: vi.fn(async (command) => { commands.push(command); return '' }),
      script: vi.fn(async (script) => { scripts.push(script); return '' })
    }
    await stageDevboxCredentialEnv(runner, 'roam', path)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain(`SMOKE_TOKEN='${TOKEN}'`)
    expect(commands.join('\n')).not.toContain(TOKEN)
  })

  it('constructs a value-free tmux refresh command and sources the env file only in the attached shell', () => {
    const refresh = buildDevboxShellEnvironmentRefreshScript('roam', 'devbox-roam-1-smoke')
    const privateRefresh = buildDevboxShellEnvironmentRefreshScript('roam', 'devbox-roam-1-smoke', 'devbox-01ff033d051e')
    execFileSync('bash', ['-n'], { input: refresh })
    execFileSync('bash', ['-n'], { input: privateRefresh })
    expect(privateRefresh).toContain("tmux -f /dev/null -L 'devbox-01ff033d051e' set-environment -t")
    const source = buildDevboxShellSourceCommand('roam')
    expect(refresh).toContain('set-environment -t')
    expect(refresh).not.toContain(TOKEN)
    // Why: `tmux -C` with no attach target mints a session per invocation, which
    // leaked one orphan per env var on every attach. Never reintroduce it here.
    expect(refresh).not.toContain('tmux -C')
    expect(source).toBe(
      `devbox_env_path='/dev/shm/devbox-roam.env'; if [ "$(uname -s)" = Darwin ]; then devbox_env_path="$(getconf DARWIN_USER_TEMP_DIR)devbox-roam.env"; fi; set -a; . "$devbox_env_path" 2>/dev/null; set +a; exec $SHELL`
    )
  })

  it('refreshes the environment without creating any tmux session', () => {
    const tmuxAvailable = (() => {
      try {
        execFileSync('tmux', ['-V'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })()
    if (!tmuxAvailable) {
      return
    }

    const socket = `devbox-test-${process.pid}-${Date.now()}`
    const tmux = (...args: string[]) =>
      execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...args], { encoding: 'utf8' })
    const sessionCount = () =>
      tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').filter(Boolean).length

    const session = 'devbox-roam-1-smoke'
    try {
      tmux('new-session', '-d', '-s', session, '-c', tmpdir())
      expect(sessionCount()).toBe(1)

      // Match the staged remote format exactly: values are shell-quoted (see
      // stageDevboxCredentialEnv), which is what makes `. "$env_file"` safe.
      const envPath = temporaryEnvFile(
        ["PLAIN='value'", "SPACED='two words'", "QUOTED='with'\\''quote'", "EMPTY=''", ''].join('\n')
      )
      const refresh = buildDevboxShellEnvironmentRefreshScript('roam', session, socket)
        .replace(/^devbox_env_path=.*$/mu, `devbox_env_path=${JSON.stringify(envPath)}`)
      execFileSync('bash', ['-c', refresh], { stdio: 'ignore' })

      // The leak regression: a refresh must not add sessions.
      expect(sessionCount()).toBe(1)
      // And the values must survive exactly.
      expect(tmux('show-environment', '-t', session, 'SPACED').trim()).toBe('SPACED=two words')
      expect(tmux('show-environment', '-t', session, 'QUOTED').trim()).toBe("QUOTED=with'quote")
    } finally {
      try {
        tmux('kill-session', '-t', session)
      } catch {
        /* session already gone */
      }
    }
  })
})
