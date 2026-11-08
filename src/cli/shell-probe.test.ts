import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createDevboxShellProbeCache } from './shell-probe-cache'
import { buildDevboxShellProbeCommand, buildDevboxShellProbeScript, parseDevboxShellProbeOutput } from './shell-probe-script'
import { DEVBOX_SHELL_LIST_DIRECT_BUDGET, DEVBOX_SHELL_LIST_PROXIED_BUDGET, devboxShellListBudget, runDevboxShellProbe, type DevboxShellProbeSpawn } from './shell-probe-run'
import { devboxShellSocketName } from './shell-tmux'

const endpoint = { host: '203.0.113.10', port: 22, username: 'sample' }

function row(cwd: string, session: string, created: number, attached: number): string {
  return [cwd, session, String(created), String(attached), String(created + 5), 'zsh', 'title'].join('\t')
}

type FakeChild = ChildProcess & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean }

function fakeSpawn(script: (child: FakeChild) => void): { spawn: DevboxShellProbeSpawn; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    spawn: (_command, args) => {
      calls.push([...args])
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false }) as unknown as FakeChild
      child.kill = (() => { child.killed = true; return true }) as ChildProcess['kill']
      setTimeout(() => script(child), 0)
      return child
    }
  }
}

describe('one-round-trip shell probe script', () => {
  it('lists every profile private socket and the default socket once, without installing tmux', () => {
    const script = buildDevboxShellProbeScript(['project', 'roam'])
    expect(script).toContain(`-L '${devboxShellSocketName('project')}'`)
    expect(script).toContain(`-L '${devboxShellSocketName('roam')}'`)
    expect(script.match(/^tmux list-sessions/gmu)).toHaveLength(1)
    expect(script).not.toMatch(/apt-get|brew|sudo/u)
    expect(buildDevboxShellProbeCommand(['roam']).startsWith("sh -c '")).toBe(true)
  })

  it('parses per-profile sessions with cwd from one output and marks the most recent', () => {
    const stdout = [
      `@@devbox-probe socket ${devboxShellSocketName('project')}`,
      row('/home/sample/project', 'devbox-project-1-agents', 100, 1),
      row('/home/sample', 'devbox-project-2', 200, 0),
      `@@devbox-probe socket ${devboxShellSocketName('roam')}`,
      '@@devbox-probe socket -',
      row('/tmp', 'devbox-roam-3-legacyless', 50, 0),
      row('/tmp', 'someone-elses-session', 50, 0),
      '@@devbox-probe end'
    ].join('\n')
    const parsed = parseDevboxShellProbeOutput(['project', 'roam'], stdout)
    expect(parsed.tmux).toBe(true)
    const project = parsed.results.get('project')!
    expect(project.sessions.map((session) => [session.id, session.name, session.attached, session.cwd, session.mostRecent])).toEqual([
      [1, 'agents', true, '/home/sample/project', false],
      [2, undefined, false, '/home/sample', true]
    ])
    expect(project.mostRecentId).toBe(2)
    expect(parsed.results.get('roam')!.sessions.map((session) => session.sessionName)).toEqual(['devbox-roam-3-legacyless'])
  })

  it('treats a host without tmux as having no shells and rejects truncated output', () => {
    expect(parseDevboxShellProbeOutput(['roam'], '@@devbox-probe no-tmux\n').results.get('roam')!.sessions).toEqual([])
    expect(() => parseDevboxShellProbeOutput(['roam'], '@@devbox-probe socket -\n')).toThrow(/truncated/u)
  })
})

describe('shell probe budget', () => {
  it('uses a 3 s connect timeout for direct hosts and a longer one through a ProxyCommand', async () => {
    expect(devboxShellListBudget(endpoint)).toBe(DEVBOX_SHELL_LIST_DIRECT_BUDGET)
    expect(devboxShellListBudget({ ...endpoint, extraOptions: ['ProxyCommand=devbox proxy', 'HostKeyAlias=devbox'] })).toBe(DEVBOX_SHELL_LIST_PROXIED_BUDGET)
    const fake = fakeSpawn((child) => { child.stdout.emit('data', Buffer.from('ok')); child.emit('close', 0) })
    await expect(runDevboxShellProbe({ endpoint, local: false }, 'true', DEVBOX_SHELL_LIST_DIRECT_BUDGET, {}, fake.spawn)).resolves.toBe('ok')
    expect(fake.calls[0]).toContain('ConnectTimeout=3')
  })

  it('kills a silent host at the per-host cap', async () => {
    const fake = fakeSpawn(() => undefined)
    const started = Date.now()
    await expect(runDevboxShellProbe({ endpoint, local: false }, 'true', { connectTimeoutMs: 30, capMs: 40, wakeCapMs: 40 }, {}, fake.spawn))
      .rejects.toThrow(/no answer within 0\.\d s/u)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('reports an ssh connect timeout plainly', async () => {
    const fake = fakeSpawn((child) => {
      child.stderr.emit('data', Buffer.from('ssh: connect to host 203.0.113.10 port 22: Operation timed out\n'))
      child.emit('close', 255)
    })
    await expect(runDevboxShellProbe({ endpoint, local: false }, 'true', DEVBOX_SHELL_LIST_DIRECT_BUDGET, {}, fake.spawn))
      .rejects.toMatchObject({ reason: 'connect-timeout', message: 'connect timed out after 3.0 s' })
  })

  it('extends the cap while the proxy reports that it is waking the box', async () => {
    const waking: string[] = []
    const fake = fakeSpawn((child) => {
      child.stderr.emit('data', Buffer.from('devbox: stopped, asking it to start...\n'))
      setTimeout(() => { child.stdout.emit('data', Buffer.from('done')); child.emit('close', 0) }, 80)
    })
    await expect(runDevboxShellProbe({ endpoint, local: false }, 'true', { connectTimeoutMs: 1_000, capMs: 30, wakeCapMs: 1_000 }, { onWaking: (message) => waking.push(message) }, fake.spawn))
      .resolves.toBe('done')
    expect(waking).toEqual(['stopped, asking it to start'])
  })
})

describe('unreachable host memory', () => {
  it('remembers a failure for the TTL, forgets it on success, and survives a corrupt file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'devbox-probe-cache-')), 'shell-ls-unreachable.json')
    let now = 1_000_000
    const cache = createDevboxShellProbeCache(file, { ttlMs: 60_000, now: () => now })
    expect(cache.recentUnreachable('sample@h:22')).toBeUndefined()
    cache.markUnreachable('sample@h:22', 'connect timed out after 3.0 s')
    now += 12_000
    expect(cache.recentUnreachable('sample@h:22')).toEqual({ at: 1_000_000, error: 'connect timed out after 3.0 s' })
    now += 60_000
    expect(cache.recentUnreachable('sample@h:22')).toBeUndefined()
    cache.markUnreachable('sample@h:22', 'refused')
    cache.markReachable('sample@h:22')
    expect(cache.recentUnreachable('sample@h:22')).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 1, hosts: {} })
    expect(createDevboxShellProbeCache(join(tmpdir(), 'devbox-missing-dir-x', 'nope.json')).recentUnreachable('k')).toBeUndefined()
  })
})
