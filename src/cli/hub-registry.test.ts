import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { HubRecord, SpokeRecord } from './hub-types'
import {
  buildHubReadScript,
  buildHubWriteScript,
  HUB_READ_MARKERS,
  parseHubReadOutput
} from './hub-registry-script'

const temporaryRoots: string[] = []

describe('hub registry scripts', () => {
  it('quotes roots safely and reads all marker sections', () => {
    const home = makeTempRoot()
    const root = join(home, "workspace with spaces and it's a `tick`")
    mkdirSync(root)
    const script = buildHubReadScript({ hubId: 'abc123', remoteRoot: root })
    expect(script).toContain("root='/")
    expect(script).toContain("'\\''")
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, HOME: home } })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(HUB_READ_MARKERS.root)
    expect(parseHubReadOutput(result.stdout).rootState).toBe('exists-empty')
  })

  it('uses a quoted heredoc and never overwrites an existing hub record', () => {
    const home = makeTempRoot()
    const dir = join(home, '.local/state/devbox/hub/abc123')
    mkdirSync(dir, { recursive: true })
    const existing = '{"hubId":"old"}\n'
    writeFileSync(join(dir, 'hub.json'), existing)
    const script = buildHubWriteScript({ hubId: 'abc123', hubRecord: hubRecord('new'), spokeRecord: spokeRecord('spoke-1') })
    expect(script).toContain("cat > \"$f\" <<'DEVBOX_JSON'")
    expect(script).toContain('HUB-WRITE-OK')
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, HOME: home } })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('HUB-WRITE-OK')
    expect(readFileSync(join(dir, 'hub.json'), 'utf8')).toBe(existing)
    expect(JSON.parse(readFileSync(join(dir, 'spokes/spoke-1.json'), 'utf8'))).toEqual(spokeRecord('spoke-1'))
    expect(statSync(join(dir, 'hub.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'spokes/spoke-1.json')).mode & 0o777).toBe(0o600)
  })

  it('round-trips zero, one, and two spokes, including spoke-root markers and agent counts', () => {
    const home = makeTempRoot()
    const root = join(home, "workspace with spaces and it's a root")
    mkdirSync(root)
    mkdirSync(join(home, '.local/state/devbox'), { recursive: true })
    writeFileSync(join(home, '.local/state/devbox/spoke-roots.json'), JSON.stringify({ schemaVersion: 1, roots: [root] }))
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "%s\\n" "mutagen-agent synchronizer" "mutagen-agent synchronizer" "other"\n', { mode: 0o755 })
    const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }
    const hub = hubRecord('abc123')
    const spokeOne = spokeRecord('one')
    const spokeTwo = spokeRecord('two')
    const writeOne = spawnSync('bash', ['-s'], { input: buildHubWriteScript({ hubId: 'abc123', hubRecord: hub, spokeRecord: spokeOne }), encoding: 'utf8', env })
    expect(writeOne.status).toBe(0)
    const writeTwo = spawnSync('bash', ['-s'], { input: buildHubWriteScript({ hubId: 'abc123', hubRecord: null, spokeRecord: spokeTwo }), encoding: 'utf8', env })
    expect(writeTwo.status).toBe(0)
    const read = spawnSync('bash', ['-s'], { input: buildHubReadScript({ hubId: 'abc123', remoteRoot: root }), encoding: 'utf8', env })
    expect(read.status).toBe(0)
    expect(parseHubReadOutput(read.stdout)).toMatchObject({ rootState: 'exists-empty', hub, spokes: [spokeOne, spokeTwo], liveAgentCount: 2, isSpokeRoot: true })
    rmSync(root, { recursive: true, force: true })
    const missing = spawnSync('bash', ['-s'], { input: buildHubReadScript({ hubId: 'abc123', remoteRoot: root }), encoding: 'utf8', env })
    expect(missing.status).toBe(0)
    expect(parseHubReadOutput(missing.stdout)).toMatchObject({ rootState: 'missing', hub, spokes: [spokeOne, spokeTwo], liveAgentCount: 2, isSpokeRoot: true })
    writeFileSync(root, 'not a directory')
    const notDirectory = spawnSync('bash', ['-s'], { input: buildHubReadScript({ hubId: 'abc123', remoteRoot: root }), encoding: 'utf8', env })
    expect(notDirectory.status).toBe(0)
    expect(parseHubReadOutput(notDirectory.stdout).rootState).toBe('exists-notdir')
  })

  it('parses valid records while skipping malformed lines and missing sections', () => {
    const hub = hubRecord('hub')
    const first = spokeRecord('one')
    const second = spokeRecord('two')
    const output = [
      HUB_READ_MARKERS.root,
      'exists-nonempty',
      HUB_READ_MARKERS.hub,
      JSON.stringify(hub),
      HUB_READ_MARKERS.spokes,
      'not json',
      JSON.stringify(first),
      JSON.stringify(second),
      HUB_READ_MARKERS.agents,
      '7',
      HUB_READ_MARKERS.spokeRoots,
      'yes',
      HUB_READ_MARKERS.end
    ].join('\n')
    expect(parseHubReadOutput(output)).toEqual({
      rootState: 'exists-nonempty',
      hub,
      spokes: [first, second],
      liveAgentCount: 7,
      isSpokeRoot: true
    })
    expect(parseHubReadOutput('')).toEqual({ rootState: 'unknown', hub: null, spokes: [], liveAgentCount: null, isSpokeRoot: false })
  })
})

describe('hub registry operations', () => {
  it('registers a new hub and spoke using injected timestamps', async () => {
    const runner = new FakeRunner([readOutput('missing'), 'HUB-WRITE-OK\n', readOutput('registered')])
    const target = makeTarget(runner)
    const facts = spokeFacts('spoke-1')
    const result = await (await import('./hub-registry')).registerHubAndSpoke(target, facts, { now: () => new Date('2026-01-02T03:04:05.000Z') })
    expect(result.registered).toBe(true)
    expect(runner.scripts).toHaveLength(3)
    expect(runner.timeouts).toEqual([15_000, 15_000, 15_000])
    expect(runner.scripts[1]).toContain('2026-01-02T03:04:05.000Z')
  })

  it('preserves registeredAt when registering an existing spoke', async () => {
    const runner = new FakeRunner([readOutput('existing'), 'HUB-WRITE-OK\n', readOutput('existing')])
    const target = makeTarget(runner)
    const result = await (await import('./hub-registry')).registerHubAndSpoke(target, spokeFacts('spoke-1'), { now: () => new Date('2026-02-02T03:04:05.000Z') })
    expect(result.registered).toBe(true)
    expect(runner.scripts[1]).toContain('2025-01-01T00:00:00.000Z')
    expect(runner.scripts[1]).toContain('2026-02-02T03:04:05.000Z')
  })

  it('returns unreachable reads and rejects unreachable or chained registration', async () => {
    const { readHub, registerHubAndSpoke } = await import('./hub-registry')
    const unreachable = new FakeRunner([new Error('ssh failed\n(exit 255)')])
    const result = await readHub(makeTarget(unreachable), 'spoke-1')
    expect(result.reachable).toBe(false)
    await expect(registerHubAndSpoke(makeTarget(new FakeRunner([new Error('offline')])) , spokeFacts('spoke-1'))).rejects.toMatchObject({ context: { field: 'hub-unreachable' } })
    await expect(registerHubAndSpoke(makeTarget(new FakeRunner([readOutput('chaining')])), spokeFacts('spoke-1'))).rejects.toMatchObject({ context: { field: 'hub-root-is-a-spoke' } })
    await expect(registerHubAndSpoke(makeTarget(new FakeRunner([readOutput('missing'), 'HUB-WRITE-OK\n', new Error('lost after write')])), spokeFacts('spoke-1'))).rejects.toMatchObject({ context: { field: 'hub-unreachable' } })
  })

  it('does not write a heartbeat for an unregistered spoke', async () => {
    const runner = new FakeRunner([readOutput('registered-without-spoke')])
    const { touchSpoke } = await import('./hub-registry')
    const result = await touchSpoke(makeTarget(runner), spokeFacts('missing'), { now: () => new Date('2026-03-01T00:00:00.000Z') })
    expect(result?.registered).toBe(true)
    expect(runner.scripts).toHaveLength(1)
  })
})

class FakeRunner implements DevboxSshRunner {
  readonly scripts: string[] = []
  readonly timeouts: number[] = []
  private readonly responses: (string | Error)[]

  constructor(responses: (string | Error)[]) {
    this.responses = responses
  }

  async command(_command: string): Promise<string> {
    throw new Error('command was not expected')
  }

  async script(script: string, timeoutMs?: number): Promise<string> {
    this.scripts.push(script)
    if (timeoutMs !== undefined) {this.timeouts.push(timeoutMs)}
    const response = this.responses.shift()
    if (response instanceof Error) {
      throw response
    }
    return response ?? ''
  }
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devbox-hub-test-'))
  temporaryRoots.push(root)
  return root
}

function makeTarget(ssh: DevboxSshRunner) {
  return { ssh, host: 'hub.example', port: 22, user: 'devbox', remoteRoot: '/srv/workspace' }
}

function spokeFacts(spokeId: string) {
  return { spokeId, hostname: 'local', platform: 'darwin', username: 'sample', localRoot: '/Users/sample/workspace', profileId: 'default', devboxVersion: '0.2.17' }
}

function hubRecord(hubId: string): HubRecord {
  return { hubId, root: '/srv/workspace', host: 'hub.example', user: 'devbox', createdAt: '2025-01-01T00:00:00.000Z', createdBy: { spokeId: 'spoke-1', hostname: 'local' }, devboxVersion: '0.2.17' }
}

function spokeRecord(spokeId: string): SpokeRecord {
  return { ...spokeFacts(spokeId), registeredAt: '2025-01-01T00:00:00.000Z', lastSeenAt: '2025-01-02T00:00:00.000Z' }
}

function readOutput(kind: 'missing' | 'registered' | 'existing' | 'chaining' | 'registered-without-spoke'): string {
  const hub = hubRecord('hub-id')
  const spoke = spokeRecord('spoke-1')
  const lines = [HUB_READ_MARKERS.root, 'exists-nonempty', HUB_READ_MARKERS.hub]
  if (kind !== 'missing') {
    lines.push(JSON.stringify(hub))
  }
  lines.push(HUB_READ_MARKERS.spokes)
  if (kind === 'registered' || kind === 'existing') {
    lines.push(JSON.stringify(spoke))
  }
  lines.push(HUB_READ_MARKERS.agents, '2', HUB_READ_MARKERS.spokeRoots, kind === 'chaining' ? 'yes' : 'no', HUB_READ_MARKERS.end)
  return lines.join('\n')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
