import { describe, expect, it } from 'vitest'
import { visibleWidth } from './presentation'
import { createPresentation } from './presentation'
import { renderShellDevicesStage } from './format-shell-devices'
import { formatAge, renderShellLsStatic } from './format-shell-ls'
import { createShellLsLiveRenderer } from './shell-ls-live'
import type { DevboxDeviceGroup } from './shell-devices'

const value = {
  scope: 'all-devices',
  defaultProfileId: 'roam',
  devices: [
    {
      device: 'workstation', host: '203.0.113.10', port: 22, username: 'sample', default: true, status: 'ok', elapsedMs: 812,
      profiles: [{ profileId: 'roam', default: true, reachable: true, mostRecentId: 2, sessions: [
        { id: 1, name: 'macmini', sessionName: 'devbox-roam-1-macmini', created: 1_735_725_600, attached: false, lastUsed: 1_735_725_660, currentCommand: 'node', currentTitle: 'agent title', mostRecent: false },
        { id: 2, name: 'ansyshuge', sessionName: 'devbox-roam-2-ansyshuge', created: 1_735_725_700, attached: true, lastUsed: 1_735_725_760, currentCommand: 'bash', currentTitle: '', mostRecent: true, cwd: '/home/sample/project/devbox' }
      ] }, { profileId: 'project', device: 'workstation', default: false, reachable: true, mostRecentId: 1, sessions: [
        { id: 1, sessionName: 'devbox-project-1', created: 1_735_720_000, attached: false, lastUsed: 1_735_720_100, currentCommand: 'zsh', currentTitle: '', mostRecent: true, cwd: '/home/sample' }
      ] }]
    },
    { device: 'macmini', host: '192.0.2.12', port: 22, username: 'exampleuser', default: false, status: 'unreachable', elapsedMs: 3004, error: 'connect timed out after 3.0 s', profiles: [{ profileId: 'macmini', default: false, reachable: false, error: 'connect timed out after 3.0 s', mostRecentId: null, sessions: [] }] }
  ],
  sessionCount: 3,
  unreachableCount: 1,
  elapsedMs: 1_104,
  mostRecent: { profileId: 'roam', device: 'workstation', id: 2, name: 'ansyshuge' }
}

const NOW_MS = (1_735_725_700 + 2 * 3600) * 1000
const plain = { width: 100, color: 'never' as const, env: { LANG: 'C', TERM: 'dumb' }, isTTY: false, unicode: false }

describe('all-device shell rendering', () => {
  it('renders a compact, aligned, escape-free static listing (non-TTY)', () => {
    for (const width of [80, 120]) {
      const presentation = createPresentation({ ...plain, width })
      const output = renderShellLsStatic(presentation, value, false, NOW_MS)
      const lines = output.split('\n')
      expect(lines[0]).toBe('2 devices · 1 unreachable · 3 sessions · 1.1 s')
      expect(output).toContain('workstation (default)  sample@203.0.113.10')
      expect(output).toContain('exampleuser@192.0.2.12')
      expect(output).toContain('unreachable (connect timed out after 3.0 s)')
      expect(output.match(/\* /gu)).toHaveLength(1)
      expect(output).toMatch(/NAME\s+ID\s+PROFILE\s+STATE\s+AGE/u)
      expect(output).toMatch(/\* ansyshuge\s+2\s+roam\s+attached\s+2h/u)
      expect(lines.at(-1)).toContain('db shell rm --unattached --all-devices')
      expect(['\u001b', '⠋', '✓'].some((needle) => output.includes(needle))).toBe(false)
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
    }
  })

  it('formats ages compactly', () => {
    expect([30, 600, 7200, 3 * 86_400].map((age) => formatAge(10_000_000_000, 10_000_000 - age))).toEqual(['30s', '10m', '2h', '3d'])
    expect(formatAge(NOW_MS, 0)).toBe('-')
  })

  it('streams spinners to stderr and finished device blocks to stdout on a TTY', () => {
    const stdout: string[] = []
    const stderr: string[] = []
    let now = NOW_MS
    const live = createShellLsLiveRenderer({
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
      presentation: createPresentation({ ...plain, width: 100 }),
      glyphs: true,
      now: () => now,
      intervalMs: 60_000
    })
    const groups = value.devices.map((device) => ({ device: device.device, host: device.host, port: device.port, username: device.username, profiles: device.profiles.map((profile) => ({ id: profile.profileId })) })) as unknown as DevboxDeviceGroup[]
    live.onProgress({ type: 'plan', groups, defaultProfileId: 'roam' })
    live.onProgress({ type: 'start', group: groups[0]! })
    live.onProgress({ type: 'start', group: groups[1]! })
    now += 400
    live.onProgress({ type: 'waking', group: groups[0]!, message: 'stopped, asking it to start' })
    expect(stderr.join('')).toContain('⠋ connecting')
    expect(stderr.join('')).toContain('… waking box (stopped, asking it to start) 0.4 s')
    expect(stdout).toEqual([])
    live.onProgress({ type: 'done', device: value.devices[1] as never })
    expect(stdout.join('')).toContain('✗ unreachable (connect timed out after 3.0 s)')
    expect(stderr.at(-2)).toBe('\x1b[2F\x1b[J')
    live.onProgress({ type: 'done', device: value.devices[0] as never })
    live.finish(value as never)
    expect(stdout.join('')).toContain('✓ 3 sessions · 0.8 s')
    expect(stdout.at(-1)).toContain('2 devices · 1 unreachable · 3 sessions · 1.1 s')
    expect(['\u001b[1F\u001b[J', '\u001b[2F\u001b[J']).toContain(stderr.at(-1))
  })

  it('renders all-device cleanup counts and unreachable profiles', () => {
    const presentation = createPresentation(plain)
    const result = renderShellDevicesStage(presentation, { scope: 'all-devices', count: 1, devices: [{ device: 'workstation', profiles: [{ profileId: 'roam', count: 1, sessions: ['devbox-roam-1'], reachable: true }, { profileId: 'project', count: 0, sessions: [], reachable: false, error: 'offline' }] }] })
    expect(result.body.join('\n')).toContain('workstation: 1 closed')
    expect(result.body.join('\n')).toContain('unreachable')
  })
})
