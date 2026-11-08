import { describe, expect, it } from 'vitest'
import { formatDevboxStage } from './format'
import { visibleWidth } from './presentation'

const plain = { width: 120, env: { LANG: 'C', TERM: 'dumb' }, isTTY: false, unicode: false }

function statusResult(violation = false) {
  return {
    profileId: 'work',
    binary: { path: '/opt/mutagen', version: '0.18.1', dataDirectory: '/state/mutagen' },
    service: { platform: 'darwin', manager: 'launchd', label: 'org.devbox.mutagen-daemon', unitPath: '/tmp/daemon.plist', wrapperPath: '/tmp/wrapper', logPath: '/tmp/mutagen.log', installed: true, loaded: true, running: true, pid: 83787 },
    daemon: { running: true, pid: 83787, origin: 'service', binaryPath: '/opt/mutagen', version: '0.18.1', dataDirectory: '/state/mutagen', lastCycleAt: Date.now() - 2_000 },
    sessions: [
      { identifier: 'session-1', name: 'work', labels: {}, profileId: 'work', rootClass: 'portable-working', status: 'watching', paused: false, successfulCycles: 2, conflictCount: 0, problemCount: 0, lastError: null, alpha: { protocol: 'local', host: null, user: null, port: null, path: '/local/work', connected: true }, beta: { protocol: 'ssh', host: 'hub.example.com', user: 'sample', port: 22, path: '/home/sample/work', connected: true }, topology: violation ? 'violation' : 'spoke-to-hub' },
      { identifier: 'session-2', name: 'portable', labels: {}, profileId: 'work', rootClass: 'portable-working', status: 'watching', paused: false, successfulCycles: 4, conflictCount: 1, problemCount: 0, lastError: null, alpha: { protocol: 'local', host: null, user: null, port: null, path: '/local/work', connected: true }, beta: { protocol: 'ssh', host: 'hub.example.com', user: 'sample', port: 22, path: '/home/sample/work', connected: true }, topology: violation ? 'violation' : 'spoke-to-hub' }
    ],
    topology: { verdict: violation ? 'violation' : 'ok', violations: violation ? ['session points at another spoke'] : [] },
    hub: { reachable: true, hubId: 'hub-1', root: '/home/sample/work', host: 'hub.example.com', port: 22, user: 'sample', registered: true, record: { hubId: 'hub-1', root: '/home/sample/work', host: 'hub.example.com', user: 'sample', createdAt: '2026-01-01T00:00:00Z', createdBy: { spokeId: 'spoke-1', hostname: 'laptop' }, devboxVersion: '0.3.0' }, spokes: [{ spokeId: 'spoke-1', hostname: 'laptop', platform: 'darwin', username: 'sample', localRoot: '/local/work', profileId: 'work', devboxVersion: '0.3.0', registeredAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z' }, { spokeId: 'spoke-2', hostname: 'builder', platform: 'linux', username: 'ci', localRoot: '/srv/work', profileId: 'work', devboxVersion: '0.3.0', registeredAt: '2026-01-02T00:00:00Z', lastSeenAt: '2026-01-03T00:00:00Z' }], thisSpokeId: 'spoke-1', liveAgentCount: 1 },
    hints: []
  }
}

describe('Mutagen and workspace formatters', () => {
  it('renders a width-safe status with topology and hub details', () => {
    for (const width of [120, 70]) {
      const rendered = formatDevboxStage(statusResult(), `status-${width}`, 'mutagen status', { ...plain, width })
      expect(rendered).not.toContain('\u001b[')
      expect(rendered).toContain('spoke→hub')
      expect(rendered).toContain('hub.example.com')
      expect(rendered.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
    }
  })

  it('marks topology violations as errors', () => {
    const rendered = formatDevboxStage(statusResult(true), 'violation-key', 'mutagen status', plain)
    expect(rendered).toContain('[error]')
    expect(rendered).toContain('VIOLATION')
    expect(rendered).toContain('Topology violations')
  })

  it('keeps rich status, action, log, and spoke views width-safe', () => {
    for (const width of [70, 100, 140]) {
      const rendered = formatDevboxStage(statusResult(), `rich-${width}`, 'mutagen status', { ...plain, width })
      expect(rendered).toContain('spoke→hub')
      expect(rendered).toContain('* spoke-1')
      expect(rendered).toContain('2026-01-03T00:00:00Z')
      expect(rendered.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
    }
    const setup = formatDevboxStage({ ...statusResult(), service: { ...statusResult().service, action: 'installed' } }, 'setup-key', 'mutagen setup', plain)
    expect(setup).toContain('Devbox Mutagen setup')
    const start = formatDevboxStage({ ...statusResult(), via: 'launchd' }, 'start-key', 'mutagen start', plain)
    expect(start).toContain('Devbox Mutagen start')
    const stop = formatDevboxStage({ ...statusResult(), daemon: { ...statusResult().daemon, running: false }, via: 'launchd' }, 'stop-key', 'mutagen stop', plain)
    expect(stop).toContain('Devbox Mutagen stop')
    const log = formatDevboxStage({ logPath: '/tmp/mutagen.log', exists: false, lines: [] }, 'log-key', 'mutagen logs', plain)
    expect(log).toContain('Log file not found')
    const pause = formatDevboxStage({ profileId: 'work', action: 'pause', sessions: [{ identifier: 'session-1', name: 'work', ok: false, error: 'conflict' }] }, 'pause-key', 'mutagen pause', plain)
    expect(pause).toContain('[error] pause failed')
    const spokes = formatDevboxStage({ profileId: 'work', hub: statusResult().hub }, 'spokes-key', 'mutagen spokes', plain)
    expect(spokes).toContain('spoke-2')
  })

  it('renders ready, blocked, and failed workspace outcomes', () => {
    const base = { mode: 'init', profileId: 'work', host: 'hub.example.com', port: 22, user: 'sample', localRoot: '/local/work', remoteRoot: '/home/sample/work', fingerprint: null, pair: null, mutagen: null, nextSteps: ['Run devbox mutagen status'] }
    const ready = formatDevboxStage({ ...base, status: 'ready', steps: [{ id: 'profile', status: 'ok', detail: 'saved' }] }, 'ready-key', 'init', plain)
    expect(ready).toContain('[ok] workspace ready')
    const blocked = formatDevboxStage({ ...base, status: 'blocked', steps: [{ id: 'pair', status: 'warning', detail: 'needs attention' }] }, 'blocked-key', 'connect', plain)
    expect(blocked).toContain('[warn] profile saved but not paired')
    const failed = formatDevboxStage({ ...base, status: 'failed', steps: [{ id: 'remote', status: 'failed', detail: 'unreachable' }] }, 'failed-key', 'init', plain)
    expect(failed).toContain('[error] stopped at remote')
  })
})
