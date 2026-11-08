import { describe, expect, it } from 'vitest'
import {
  buildMutagenActionArgs,
  buildMutagenCreateArgs,
  buildMutagenDaemonArgs,
  buildMutagenMonitorArgs,
  buildMutagenStateArgs
} from './mutagen-cli-argv'
import { MUTAGEN_JSON_TEMPLATE } from './mutagen-cli-types'

describe('Mutagen CLI argv', () => {
  it('renders canonical exclusions without rsync syntax', () => {
    const args = buildMutagenCreateArgs(
      {
        profileId: 'profile-one',
        sessionId: 'session-one',
        rootClassId: 'working',
        localRoot: '/local/project',
        remoteRoot: '/remote/project',
        mode: 'two-way-safe'
      },
      {
        remoteEndpoint: 'user@example:/remote/project',
        name: 'session-one',
        labels: {}
      }
    )
    const ignoreArguments = args.filter((argument) => argument.startsWith('--ignore='))

    expect(ignoreArguments).toContain('--ignore=node_modules/')
    expect(ignoreArguments).toContain('--ignore=.pi/agent/secrets.env')
    expect(ignoreArguments).toContain('--ignore=**/*token*')
    expect(ignoreArguments.every((argument) => !argument.startsWith('--ignore=- '))).toBe(true)
  })

  it('renders a profile watch polling override without changing entry limits or exclusions', () => {
    const args = buildMutagenCreateArgs(
      {
        profileId: 'profile-one',
        sessionId: 'session-one',
        rootClassId: 'working',
        localRoot: '/local/project',
        remoteRoot: '/remote/project',
        mode: 'two-way-safe',
        watchPollingIntervalSeconds: 60,
        maxEntryCount: 2_000_000,
        excludes: ['project-specific/']
      },
      {
        remoteEndpoint: 'user@example:/remote/project',
        name: 'session-one',
        labels: {}
      }
    )
    expect(args).toContain('--watch-polling-interval=60')
    expect(args).toContain('--max-entry-count=2000000')
    expect(args).toContain('--ignore=project-specific/')
    expect(args).not.toContain('--watch-polling-interval=10')
  })

  it('passes no staging file-size cap unless a caller opts in explicitly', () => {
    // Mutagen does not skip over-cap files; it aborts their staging and retries the
    // whole transfer every cycle, so a default cap must never be emitted.
    const request = {
      profileId: 'profile-one',
      sessionId: 'session-one',
      rootClassId: 'working',
      localRoot: '/local/project',
      remoteRoot: '/remote/project',
      mode: 'two-way-safe' as const
    }
    const options = { remoteEndpoint: 'user@example:/remote/project', name: 'session-one', labels: {} }

    const defaults = buildMutagenCreateArgs(request, options)
    expect(defaults.some((argument) => argument.startsWith('--max-staging-file-size='))).toBe(false)

    const explicit = buildMutagenCreateArgs(request, { ...options, maxStagingFileSize: '8 GB' })
    expect(explicit).toContain('--max-staging-file-size=8 GB')
  })

  it('renders resolved mode with only explicit exclusions', () => {
    const args = buildMutagenCreateArgs(
      {
        profileId: 'profile-one',
        sessionId: 'session-one',
        rootClassId: 'credentials',
        localRoot: '/local/.mcp-auth',
        remoteRoot: '/remote/.mcp-auth',
        mode: 'two-way-resolved',
        exclusionPolicy: 'explicit-only',
        excludes: ['*_lock.json', '*_debug.log']
      },
      {
        remoteEndpoint: 'user@example:/remote/.mcp-auth',
        name: 'session-one',
        labels: {}
      }
    )

    expect(args).toEqual([
      'sync',
      'create',
      '--paused',
      '--no-global-configuration',
      '--mode=two-way-resolved',
      '--name=session-one',
      '--permissions-mode=portable',
      '--default-file-mode=0600',
      '--default-directory-mode=0700',
      '--symlink-mode=portable',
      '--watch-mode=portable',
      '--watch-polling-interval=10',
      '--stage-mode=neighboring',
      '--max-entry-count=2000000',
      '--ignore-vcs',
      '--ignore=*_lock.json',
      '--ignore=*_debug.log',
      '--',
      '/local/.mcp-auth',
      'user@example:/remote/.mcp-auth'
    ])
    expect(args).not.toContain('--ignore=**/*token*')
  })

  it('renders one-way-replica with an ignore-all plus ordered negations', () => {
    const args = buildMutagenCreateArgs(
      {
        profileId: 'profile-one',
        sessionId: 'profile-one-paste-clipboard',
        rootClassId: 'paste',
        localRoot: '/tmp/devbox-temp/ab/cd/T',
        remoteRoot: '/tmp/devbox-temp/ab/cd/T',
        mode: 'one-way-replica',
        exclusionPolicy: 'explicit-only',
        maxEntryCount: 50_000,
        excludes: ['*', '!terminal-paste-*']
      },
      {
        remoteEndpoint: 'user@example:/tmp/devbox-temp/ab/cd/T',
        name: 'session-one',
        labels: {},
        maxEntryCount: 50_000
      }
    )

    expect(args).toContain('--mode=one-way-replica')
    expect(args).toContain('--max-entry-count=50000')
    const ignores = args.filter((argument) => argument.startsWith('--ignore='))
    expect(ignores).toEqual(['--ignore=*', '--ignore=!terminal-paste-*'])
    expect(args.slice(-3)).toEqual(['--', '/tmp/devbox-temp/ab/cd/T', 'user@example:/tmp/devbox-temp/ab/cd/T'])
  })

  it('limits --no-global-configuration to sync create', () => {
    const nonCreateArgs = [
      buildMutagenStateArgs(['sync', 'list', '--label-selector=profile=one']),
      buildMutagenMonitorArgs('session-one'),
      buildMutagenActionArgs('pause', 'session-one'),
      buildMutagenActionArgs('resume', 'session-one'),
      buildMutagenActionArgs('flush', 'session-one'),
      buildMutagenActionArgs('terminate', 'session-one'),
      buildMutagenDaemonArgs('start'),
      buildMutagenDaemonArgs('stop')
    ]

    for (const args of nonCreateArgs) {
      expect(args).not.toContain('--no-global-configuration')
    }
    expect(buildMutagenStateArgs(['sync', 'list'])).toContain(`--template=${MUTAGEN_JSON_TEMPLATE}`)
    expect(buildMutagenMonitorArgs('session-one')).toContain(`--template=${MUTAGEN_JSON_TEMPLATE}`)
  })
})
