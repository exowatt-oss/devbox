import { describe, expect, it } from 'vitest'
import { listMutagenSessionViews, parseMutagenSessionViews, type ListMutagenSessionViewsOptions } from './mutagen-sessions'
import type { ServiceExec } from './mutagen-service'

const hub = {
  host: '203.0.113.10',
  user: 'sample',
  remoteRoot: '/home/sample/project',
  localRoot: '/Users/sample/project'
}

const endpoint = {
  protocol: 'local',
  host: null,
  user: null,
  port: null,
  path: '/Users/sample/project',
  connected: true
}

const ssh = {
  protocol: 'ssh',
  host: '203.0.113.10',
  user: 'sample',
  port: null,
  path: '/home/sample/project',
  connected: true
}

function session(identifier: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier,
    name: identifier,
    labels: { 'devbox-backend': 'mutagen', 'devbox-profile': 'portable' },
    status: 'watching',
    paused: false,
    successfulCycles: 7,
    alpha: endpoint,
    beta: ssh,
    conflicts: [],
    ...overrides
  }
}

describe('mutagen session discovery', () => {
  it('filters ownership, counts problems/conflicts, and verifies hub topology', () => {
    const input = JSON.stringify([
      session('good', {
        alpha: { ...endpoint, scanProblems: ['one'], transitionProblems: ['two'] },
        beta: { ...ssh, scanProblems: ['three'], transitionProblems: ['four'] },
        conflicts: [{ path: 'a' }]
      }),
      session('local-local', { beta: { ...endpoint, path: '/tmp/other' }, conflicts: [{ path: 'b' }, { path: 'c' }] }),
      { identifier: 'foreign', labels: { owner: 'someone-else' }, alpha: endpoint, beta: ssh },
      { identifier: 'missing-profile', labels: { 'devbox-backend': 'mutagen' }, alpha: endpoint, beta: ssh }
    ])

    const result = parseMutagenSessionViews(input, { profileId: 'portable', hub })

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ identifier: 'good', topology: 'spoke-to-hub', problemCount: 4, conflictCount: 1 })
    expect(result[1]).toMatchObject({ identifier: 'local-local', topology: 'violation', conflictCount: 2 })
    expect(result[1]?.topologyDetail).toContain('local ↔ local')
  })

  it('passes the profile selector and daemon-safe environment to sync list', async () => {
    let observed: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined
    const exec: ServiceExec = async (command, args, options) => {
      observed = { command, args, env: options?.env }
      return { exitCode: 0, stdout: JSON.stringify([session('good')]), stderr: '' }
    }
    const options: ListMutagenSessionViewsOptions = {
      binaryPath: '/tmp/mutagen',
      dataDirectory: '/tmp/state/mutagen',
      profileId: 'portable',
      env: { HOME: '/tmp/home', TMPDIR: '/tmp/tmp', PATH: '/usr/bin' },
      exec
    }

    const result = await listMutagenSessionViews(options)

    expect(result.available).toBe(true)
    expect(observed?.command).toBe('/tmp/mutagen')
    expect(observed?.args).toEqual(['sync', 'list', '--template', '{{json .}}', '--label-selector=devbox-profile=portable'])
    expect(observed?.env).toMatchObject({ HOME: '/tmp/home', TMPDIR: '/tmp/tmp', PATH: '/usr/bin', MUTAGEN_DATA_DIRECTORY: '/tmp/state/mutagen', MUTAGEN_DISABLE_AUTOSTART: '1' })
  })

  it('accepts the same local root as a spoke of two different hubs (multi-hub)', () => {
    const projectHub = { host: '203.0.113.10', user: 'sample', remoteRoot: '/home/sample/project', localRoot: '/Users/sample/project' }
    const macminiHub = { host: '192.0.2.12', user: 'exampleuser', remoteRoot: '/Users/exampleuser/project', localRoot: '/Users/sample/project' }
    const sharedAlpha = { ...endpoint, path: '/Users/sample/project' }

    const projectSessions = parseMutagenSessionViews(
      JSON.stringify([session('project-session', { labels: { 'devbox-backend': 'mutagen', 'devbox-profile': 'project' }, alpha: sharedAlpha, beta: { ...ssh, host: projectHub.host, user: projectHub.user, path: projectHub.remoteRoot } })]),
      { profileId: 'project', hub: projectHub }
    )
    const macminiSessions = parseMutagenSessionViews(
      JSON.stringify([session('macmini-session', { labels: { 'devbox-backend': 'mutagen', 'devbox-profile': 'macmini' }, alpha: sharedAlpha, beta: { ...ssh, host: macminiHub.host, user: macminiHub.user, path: macminiHub.remoteRoot } })]),
      { profileId: 'macmini', hub: macminiHub }
    )

    // Same local root, two distinct hubs: each profile-scoped session is independently
    // spoke-to-hub. Devbox never conflates the two hubs into one topology violation.
    expect(projectSessions).toHaveLength(1)
    expect(macminiSessions).toHaveLength(1)
    expect(projectSessions[0]).toMatchObject({ topology: 'spoke-to-hub' })
    expect(macminiSessions[0]).toMatchObject({ topology: 'spoke-to-hub' })
  })

  it('accepts paste and credential sessions on their configured roots, flags them elsewhere', () => {
    const paste = '/tmp/devbox-temp/54/abc/T'
    const auxHub = {
      ...hub,
      auxiliaryRoots: [
        { rootClass: 'paste' as const, localRoot: paste, remoteRoot: paste },
        { rootClass: 'credentials' as const, localRoot: '/Users/sample/.mcp-auth', remoteRoot: '/home/sample/.mcp-auth' }
      ]
    }
    const labels = (rootClass: string) => ({ 'devbox-backend': 'mutagen', 'devbox-profile': 'portable', 'devbox-root-class': rootClass })
    const input = JSON.stringify([
      session('paste', { labels: labels('paste'), alpha: { ...endpoint, path: `${paste}/` }, beta: { ...ssh, path: paste } }),
      session('creds', { labels: labels('credentials'), alpha: { ...endpoint, path: '/Users/sample/.mcp-auth' }, beta: { ...ssh, path: '/home/sample/.mcp-auth' } }),
      session('paste-wrong-root', { labels: labels('paste'), alpha: { ...endpoint, path: '/tmp/elsewhere' }, beta: { ...ssh, path: paste } }),
      session('creds-wrong-host', { labels: labels('credentials'), alpha: { ...endpoint, path: '/Users/sample/.mcp-auth' }, beta: { ...ssh, host: '192.0.2.11', path: '/home/sample/.mcp-auth' } }),
      session('paste-as-creds', { labels: labels('credentials'), alpha: { ...endpoint, path: paste }, beta: { ...ssh, path: paste } }),
      session('paste-local-local', { labels: labels('paste'), alpha: { ...endpoint, path: paste }, beta: { ...endpoint, path: paste } }),
      session('working-on-paste-root', { labels: labels('portable-working'), alpha: { ...endpoint, path: paste }, beta: { ...ssh, path: paste } })
    ])

    const byId = Object.fromEntries(parseMutagenSessionViews(input, { profileId: 'portable', hub: auxHub }).map((view) => [view.identifier, view]))

    expect(byId.paste).toMatchObject({ rootClass: 'paste', topology: 'spoke-to-hub' })
    expect(byId.creds).toMatchObject({ rootClass: 'credentials', topology: 'spoke-to-hub' })
    expect(byId['paste-wrong-root']?.topologyDetail).toContain('match no configured paste root')
    expect(byId['creds-wrong-host']?.topologyDetail).toContain('hub host 192.0.2.11 != 203.0.113.10')
    expect(byId['paste-as-creds']?.topology).toBe('violation')
    expect(byId['paste-local-local']?.topologyDetail).toContain('local ↔ local')
    expect(byId['working-on-paste-root']?.topologyDetail).toContain(`local root ${paste} != /Users/sample/project`)

    // Without configured auxiliary roots a paste session cannot be vouched for.
    expect(parseMutagenSessionViews(input, { profileId: 'portable', hub })[0]?.topology).toBe('violation')
  })

  it('omits the selector without a profile and reports non-zero exits as unavailable', async () => {
    let args: readonly string[] = []
    const exec: ServiceExec = async (_command, receivedArgs) => {
      args = receivedArgs
      return { exitCode: 17, stdout: '', stderr: 'daemon is not running' }
    }

    const result = await listMutagenSessionViews({ binaryPath: '/tmp/mutagen', dataDirectory: '/tmp/state/mutagen', env: { HOME: '/tmp/home' }, exec })

    expect(args).toEqual(['sync', 'list', '--template', '{{json .}}'])
    expect(result).toEqual({ available: false, sessions: [], detail: 'daemon is not running' })
  })
})
