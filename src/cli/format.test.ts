import { afterEach, describe, expect, it, vi } from 'vitest'
import { stripAnsi, visibleWidth } from './presentation'
import { devboxExitCode, formatDevboxError, formatDevboxStage, printDevboxError, printDevboxResult } from './format'
import { DEVBOX_BLOCKED_OPERATIONS, DevboxBlockedError } from './operations'
import { createDevboxError } from '../shared/devbox-errors'

const plain = {
  color: 'never' as const,
  env: { LANG: 'C', TERM: 'dumb' },
  isTTY: false,
  unicode: false
}

afterEach(() => vi.restoreAllMocks())

describe('Devbox CLI format', () => {
  it('emits deterministic JSON envelopes and redacts secret-shaped fields', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const value = { profileId: 'p1', sync: { authToken: 'secret', state: 'ready' } }
    printDevboxResult('status', 'status', value, 'key', true, () => 'human')
    const first = output.mock.calls[0]?.[0] as string
    output.mockClear()
    printDevboxResult('status', 'status', value, 'key', true, () => 'human')
    expect(output.mock.calls[0]?.[0]).toBe(first)
    expect(first).toContain('"schemaVersion": 1')
    expect(first).toContain('[REDACTED]')
    expect(first).not.toContain('secret')
  })

  it('omits job log text from JSON while preserving availability', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printDevboxResult('jobs log', 'jobs.log', { jobId: 'j1', text: 'TOKEN=hidden' }, 'key', true, () => 'human')
    const json = output.mock.calls[0]?.[0] as string
    expect(json).toContain('"textAvailable": true')
    expect(json).not.toContain('TOKEN=hidden')
  })

  it('does not redact public hub and spoke identity fields', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printDevboxResult('mutagen status', 'mutagen.status', {
      hub: {
        record: { createdBy: { spokeId: 'spoke-1', hostname: 'laptop' } },
        spokes: [{ spokeId: 'spoke-1', hostname: 'laptop', profileId: 'work' }]
      },
      binary: { dataDirectory: '/tmp/state/mutagen', path: '/opt/mutagen', version: '0.18.1' }
    }, 'key', true, () => 'human')
    const json = String(output.mock.calls[0]?.[0])
    expect(json).toContain('"hostname": "laptop"')
    expect(json).toContain('"createdBy"')
    expect(json).not.toContain('[REDACTED]')
  })

  it('keeps the lifecycle hierarchy truthful for degraded status', () => {
    const output = formatDevboxStage({
      profileId: 'p1',
      state: 'degraded',
      generationId: 'g1',
      sync: {
        state: 'degraded',
        capability: 'two-way-safe',
        watchMode: 'Native',
        conflictCount: 2,
        degradation: 'mutagen-error',
        sessions: [{
          session: { name: 'working' },
          phase: 'watching-native',
          conflictCount: 2,
          problemCount: 1,
          lastError: 'beta scan error: remote error: exceeded allowed entry count'
        }]
      }
    }, 'status-key', 'status', plain)
    expect(output).toContain('Devbox profile status')
    expect(output).toContain('[warn] sync: degraded')
    expect(output).toMatch(/^conflicts\s+: 2$/mu)
    expect(output).toMatch(/^problems\s+: 1$/mu)
    expect(output).toContain('SESSION  PHASE')
    expect(output).not.toContain('session:')
    expect(output).not.toMatch(/[|+]/u)

    const wide = formatDevboxStage({
      profileId: 'p1',
      state: 'degraded',
      generationId: 'g1',
      sync: {
        state: 'degraded',
        capability: 'two-way-safe',
        watchMode: 'Native',
        conflictCount: 2,
        sessions: [{
          session: { name: 'working' },
          phase: 'watching-native',
          conflictCount: 2,
          problemCount: 1,
          lastError: 'beta scan error: remote error: exceeded allowed entry count'
        }]
      }
    }, 'status-wide-key', 'status', { ...plain, width: 120 })
    expect(wide).toContain('ERROR')
    expect(wide).toContain('beta scan error: remote error: exceeded allowed entry count')
    expect(output).toContain('operationKey: status-key')
    expect(output.trimEnd().endsWith('operationKey: status-key')).toBe(true)
  })

  it('bounds long status, last-error, warning, footer, and context lines at common widths', () => {
    const longError = 'remote synchronization failed while scanning the very long repository entry list'
    const longWarning = 'repository warning explains that the remote working tree needs a fresh fenced handoff'
    const value = {
      profileId: 'p1',
      state: 'degraded',
      sync: {
        state: 'degraded',
        capability: 'two-way-safe',
        watchMode: 'Native',
        conflictCount: 2,
        sessions: [{
          session: { name: 'working' },
          phase: 'watching-native',
          conflictCount: 2,
          problemCount: 1,
          lastError: longError
        }]
      },
      gitRoaming: {
        owner: 'remote',
        transition: 'degraded',
        repositories: 1,
        localGit: 'ready',
        remoteGit: 'ready',
        warnings: [{ repository: 'workspace', message: longWarning }],
        witnesses: 'remote witness'
      }
    }

    for (const width of [60, 80]) {
      const options = { ...plain, width, color: 'always' as const, isTTY: true }
      const rendered = formatDevboxStage(value, `long-${width}`, 'status', options)
      expect(rendered.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
      const normalized = stripAnsi(rendered).replace(/\s+/gu, ' ')
      expect(normalized).toContain(longError)
      expect(normalized).toContain(longWarning)
      expect(rendered).toContain('Last error')
      expect(rendered).toContain('\u001b[')

      const error = createDevboxError('offline', {
        message: longError,
        context: { field: longWarning }
      })
      const formattedError = formatDevboxError(error, options)
      expect(formattedError.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
      expect(stripAnsi(formattedError).replace(/\s+/gu, ' ')).toContain(longWarning)
    }
  })

  it('formats unattached shell removal as a counted bulk result', () => {
    for (const killed of [true, false]) {
      const rendered = formatDevboxStage({ profileId: 'p1', count: 3, killed }, 'shell-key', 'shell rm --unattached', plain)
      expect(rendered).toContain('Devbox shell sessions')
      expect(rendered).toContain('sessions: 3')
      expect(rendered).not.toContain('without displayable details')
      expect(rendered).toContain(killed ? 'Shell sessions closed' : 'Shell sessions were not closed')
    }
  })

  it('renders lifecycle commands with semantic completion and aligned profile fields', () => {
    const output = formatDevboxStage({ profileId: 'p1', state: 'ready', generationId: 'g7' }, 'pair-key', 'pair', plain)
    expect(output).toContain('[ok] Pair · ready')
    expect(output).toMatch(/^profile\s+: p1$/mu)
    expect(output).toContain('generationId: g7')
    expect(output).toContain('operationKey: pair-key')
  })

  it('renders profile lists as adaptive tables and names an empty collection', () => {
    const profiles = {
      defaultProfile: 'work',
      profiles: [
        { id: 'work', displayName: 'Workstation', username: 'sample', host: 'work.example', localRoot: '/local/work', remoteRoot: '/remote/work' },
        { id: 'lab', displayName: 'Lab', username: 'dev', host: 'lab.example', localRoot: '/local/lab', remoteRoot: '/remote/lab' }
      ]
    }
    for (const width of [60, 80, 100, 120]) {
      const rendered = formatDevboxStage(profiles, `profiles-${width}`, 'profile list', { ...plain, width })
      expect(rendered).toContain('Profiles')
      expect(rendered).toContain('* work')
      expect(rendered).toContain('USER')
      expect(rendered).toContain('HOST')
      expect(rendered).not.toMatch(/[|+]/u)
      expect(rendered.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
    }
    const wide = formatDevboxStage(profiles, 'profiles-key', 'profile list', { ...plain, width: 120 })
    expect(wide).toContain('REMOTE ROOT')

    const empty = formatDevboxStage({ defaultProfile: null, profiles: [] }, 'empty-key', 'profile list', plain)
    expect(empty).toContain('[-]')
    expect(empty).toContain('No profiles configured.')
    expect(empty).toContain('operationKey: empty-key')
  })

  it('keeps shell tables readable at wide and narrow widths with compact UTC timestamps', () => {
    const value = {
      profileId: 'p1',
      mostRecentId: 2,
      sessions: [
        { id: 1, name: 'agents', created: 1_735_725_600, attached: false, lastUsed: 1_735_725_660, currentCommand: 'node', currentTitle: 'long running agent title', mostRecent: false },
        { id: 2, created: 1_735_725_700, attached: true, lastUsed: 1_735_725_760, currentCommand: 'bash', currentTitle: '', mostRecent: true }
      ]
    }
    for (const width of [60, 80, 100, 120]) {
      const rendered = formatDevboxStage(value, `shell-${width}`, 'shell ls', { ...plain, width })
      expect(rendered).toContain('CREATED (UTC)')
      expect(rendered).toContain('Jan 01 10:00')
      expect(rendered).toContain('LIVE')
      expect(rendered).toContain('idle')
      expect(rendered).not.toMatch(/[|+]/u)
      expect(rendered.split('\n').every((line) => visibleWidth(line) <= width)).toBe(true)
    }
    const wide = formatDevboxStage(value, 'shell-wide', 'shell ls', { ...plain, width: 120 })
    expect(wide).toContain('COMMAND/TITLE')
    expect(wide).toContain('* 2')

    const narrow = formatDevboxStage(value, 'shell-narrow', 'shell ls', { ...plain, width: 34 })
    expect(narrow).toContain('ID')
    expect(narrow).toContain('CREATED (UTC)')
    expect(narrow).not.toContain('COMMAND/TITLE')
    const narrowTableLines = narrow.split('\n').filter((line) => /^(?:ID|---|\s*\*?\s*\d)/u.test(line))
    expect(narrowTableLines.every((line) => visibleWidth(line) <= 34)).toBe(true)

    const empty = formatDevboxStage({ profileId: 'p1', mostRecentId: null, sessions: [] }, 'shell-empty', 'shell ls', plain)
    expect(empty).toContain('No shell sessions.')
  })

  it('renders reconnect-all plans with action/status columns and launch footer', () => {
    const rendered = formatDevboxStage({
      profileId: 'roam',
      dryRun: false,
      rows: [
        { id: 1, name: 'main', action: 'skip-attached', status: 'planned', command: 'devbox shell 1 --profile roam' },
        { id: 2, action: 'forca', status: 'launched', handle: 'term_2', command: 'devbox shell 2 --profile roam' },
        { id: 3, action: 'here', status: 'planned', error: 'none', command: 'devbox shell 3 --profile roam' }
      ]
    }, 'reconnect-key', 'shell reconnect --all', { ...plain, width: 120 })
    expect(rendered).toContain('Devbox shell reconnect --all (roam)')
    expect(rendered).toContain('ACTION')
    expect(rendered).toContain('STATUS')
    expect(rendered).toContain('TARGET')
    expect(rendered).toContain('term_2')
    expect(rendered).toContain('1 launched in Forca · 1 resumed here · 1 already attached')
    expect(rendered).not.toContain('already open')

    const deduped = formatDevboxStage({
      profileId: 'roam',
      dryRun: false,
      rows: [{ id: 4, action: 'forca', status: 'already-open', handle: 'term_9', command: 'devbox shell 4 --profile roam' }]
    }, 'reconnect-open', 'shell reconnect --all', { ...plain, width: 120 })
    expect(deduped).toContain('already-open')
    expect(deduped).toContain('term_9')
    expect(deduped).toContain('0 launched in Forca · 0 resumed here · 0 already attached · 1 already open in Forca')

    const dryRun = formatDevboxStage({ profileId: 'roam', dryRun: true, rows: [] }, 'dry-key', 'shell reconnect --all', plain)
    expect(dryRun).toContain('Dry run — nothing launched. Re-run without --dry-run to open the tabs.')

    const everywhere = formatDevboxStage({
      scope: 'all-devices',
      dryRun: true,
      rows: [
        { id: 1, device: 'mini', title: 'main@mini', action: 'forca', status: 'planned', command: 'devbox shell devbox-mini-1-main --profile mini' },
        { id: 1, device: 'box', title: 'main@box', action: 'forca', status: 'planned', command: 'devbox shell devbox-box-1-main --profile box' }
      ],
      skippedDevices: [{ device: 'laptop', status: 'unreachable', error: 'ssh: connect timed out' }]
    }, 'all-key', 'shell reconnect --all', { ...plain, width: 160 })
    expect(everywhere).toContain('Devbox shell reconnect --all (all devices)')
    expect(everywhere).toMatch(/DEVICE\s+ID\s+TAB TITLE/u)
    expect(everywhere).toContain('main@box')
    expect(everywhere).toContain('Skipped devices')
    expect(everywhere).toContain('laptop: ssh: connect timed out')
  })

  it('renders settings, ignore rules, and generic results without changing their values', () => {
    const settings = formatDevboxStage({ profileId: 'p1', envFile: null }, 'env-key', 'profile env-file show', plain)
    expect(settings).toContain('Credential env-file')
    expect(settings).toMatch(/^path\s+: none$/mu)
    expect(settings).toContain('operationKey: env-key')

    const polling = formatDevboxStage({
      profileId: 'p1',
      watchPollingIntervalSeconds: 60,
      effectiveWatchPollingIntervalSeconds: 60
    }, 'polling-key', 'profile sync-watch-polling-interval show', plain)
    expect(polling).toContain('override : 60s')
    expect(polling).toContain('effective: 60s')
    expect(polling).toContain('disable and pair to recreate')
    expect(polling).toContain('full configured tree and entry cap are unchanged')

    const ignore = formatDevboxStage({
      profileId: 'p1',
      action: 'add',
      requiresRePair: true,
      patterns: [{ pattern: '.env', rootClass: 'portable-working' }],
      message: 'Apply on the next session.'
    }, 'ignore-key', 'profile ignore add', plain)
    expect(ignore).toContain('[warn] Ignore rules updated; re-pair required')
    expect(ignore).toContain('PATTERN')
    expect(ignore).toContain('.env')
    expect(ignore).toContain('Apply on the next session.')

    const credentials = formatDevboxStage({
      profileId: 'p1',
      enabled: true,
      roots: [{ id: 'mcp-auth', localRoot: '/local/.mcp-auth', remoteRoot: '/remote/.mcp-auth', excludes: ['*.stale-*'] }]
    }, 'credentials-key', 'profile credentials enable', plain)
    expect(credentials).toContain('Credential roaming')
    expect(credentials).toContain('mcp-auth: /local/.mcp-auth -> /remote/.mcp-auth')
    expect(credentials).toMatch(/Run: devbox pair --profile p1$/u)

    const updatedCredentials = formatDevboxStage({
      profileId: 'p1',
      enabled: true,
      updatedExistingRoot: true,
      roots: [{ id: 'mcp-auth', localRoot: '/local/.mcp-auth', remoteRoot: '/remote/.mcp-auth', excludes: ['*.stale-*'] }]
    }, 'credentials-update-key', 'profile credentials enable', plain)
    expect(updatedCredentials).toMatch(/Run: devbox disable --profile p1 && devbox pair --profile p1$/u)

    const generic = formatDevboxStage({ id: 'x1', state: 'ready', status: 'ok', knownHostsFile: '/tmp/known_hosts' }, 'generic-key', 'git', plain)
    expect(generic).toMatch(/^id\s+: x1$/mu)
    expect(generic).toContain('knownHostsFile: /tmp/known_hosts')
    expect(generic).toContain('operationKey: generic-key')
  })

  it('renders human errors as a hierarchy and preserves redaction and exit mappings', () => {
    const error = new Error('remote failure SMOKE_TOKEN=synthetic-credential-value-7f2a')
    const output = formatDevboxError(error, plain)
    expect(output).toContain('Devbox error')
    expect(output).toContain('[error] remote failure SMOKE_TOKEN=[redacted:env-value]')
    expect(output).toMatch(/^code\s+: unknown$/mu)
    expect(output).not.toContain('synthetic-credential-value-7f2a')
    expect(devboxExitCode({ code: 'operation_conflict' })).toBe(6)
    expect(devboxExitCode({ code: 'cancelled' })).toBe(130)
  })

  it('uses semantic ANSI color only when requested and keeps JSON ANSI-free', () => {
    const error = new Error('nope')
    const noColor = formatDevboxError(error, { ...plain, color: 'never' })
    const color = formatDevboxError(error, { ...plain, color: 'always', isTTY: true })
    expect(noColor).not.toContain('\u001b[')
    expect(color).toContain('\u001b[')
    expect(stripAnsi(color)).toContain('Devbox error')

    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printDevboxResult('status', 'status', { state: 'ready' }, 'json-key', true, () => 'unused', { ...plain, color: 'always' })
    printDevboxError('status', error, true, { ...plain, color: 'always' })
    const json = output.mock.calls.flat().map(String).join('\n')
    expect(json).not.toContain('\u001b[')
    expect(json).toContain('"ok": true')
    expect(json).toContain('"ok": false')
  })

  it('reports blocked operation contracts while retaining the blocked exit code', () => {
    const error = new DevboxBlockedError(DEVBOX_BLOCKED_OPERATIONS[0]!)
    const output = formatDevboxError(error, plain)
    expect(output).toContain('devbox:doctor')
    expect(output).toContain('DevboxIpcResult')
    expect(output).toContain('Blocked runtime operations required')
    expect(devboxExitCode(error)).toBe(3)
    const jsonOutput = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printDevboxError('doctor', error, true)
    expect(jsonOutput.mock.calls[0]?.[0]).toContain('"ok": false')
  })
})
