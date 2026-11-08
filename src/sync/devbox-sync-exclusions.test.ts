import { describe, expect, it } from 'vitest'
import {
  DEVBOX_SYNC_EXCLUSIONS,
  renderMutagenIgnoreArguments,
  renderRsyncFilterArguments
} from './devbox-sync-exclusions'

type RepresentativePath = {
  category: string
  path: string
  pattern: string
}

const representativePaths: readonly RepresentativePath[] = [
  {
    category: 'credentials and secrets',
    path: '.pi/agent/secrets.env',
    pattern: '.pi/agent/secrets.env'
  },
  {
    category: 'credentials and secrets',
    path: 'certificates/service.pem',
    pattern: '**/*.pem'
  },
  {
    category: 'session state',
    path: '.pi/agent/sessions/active/state.json',
    pattern: '.pi/agent/sessions/'
  },
  {
    category: 'VCS internals',
    path: '.git/config',
    pattern: '.git/'
  },
  {
    category: 'node_modules',
    path: 'node_modules/example/index.js',
    pattern: 'node_modules/'
  },
  {
    category: 'build output',
    path: 'dist/assets/app.js',
    pattern: 'dist/'
  },
  {
    category: 'caches',
    path: '.cache/tool/index.json',
    pattern: '.cache/'
  }
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function matchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith('/')) {
    const directory = pattern.slice(0, -1)
    return path === directory || path.startsWith(pattern)
  }
  const expression = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${expression}$`, 'u').test(path)
}

function mutagenPatterns(): string[] {
  return renderMutagenIgnoreArguments(DEVBOX_SYNC_EXCLUSIONS).map((argument) => {
    expect(argument.startsWith('--ignore=')).toBe(true)
    return argument.slice('--ignore='.length)
  })
}

function rsyncPatterns(): string[] {
  const argumentsForFilters = renderRsyncFilterArguments(DEVBOX_SYNC_EXCLUSIONS)
  expect(argumentsForFilters.length % 2).toBe(0)
  return argumentsForFilters
    .filter((_, index) => index % 2 === 1)
    .map((argument) => {
      expect(argument.startsWith('- ')).toBe(true)
      return argument.slice(2)
    })
}

function excludesPath(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, path))
}

describe('Devbox sync exclusion renderers', () => {
  it('keeps all 63 exclusions in canonical syntax-neutral form', () => {
    expect(DEVBOX_SYNC_EXCLUSIONS).toHaveLength(63)
    expect(DEVBOX_SYNC_EXCLUSIONS.every((pattern) => !pattern.startsWith('- '))).toBe(true)
  })

  it('renders the complete canonical set for Mutagen and rsync', () => {
    expect(renderMutagenIgnoreArguments(DEVBOX_SYNC_EXCLUSIONS)).toEqual(
      DEVBOX_SYNC_EXCLUSIONS.map((pattern) => `--ignore=${pattern}`)
    )
    expect(renderRsyncFilterArguments(DEVBOX_SYNC_EXCLUSIONS)).toEqual(
      DEVBOX_SYNC_EXCLUSIONS.flatMap((pattern) => ['--filter', `- ${pattern}`])
    )
  })

  it.each(representativePaths)('excludes $category path on both backends', ({ path, pattern }) => {
    expect(mutagenPatterns()).toContain(pattern)
    expect(rsyncPatterns()).toContain(pattern)
    expect(excludesPath(mutagenPatterns(), path)).toBe(true)
    expect(excludesPath(rsyncPatterns(), path)).toBe(true)
  })

  it('keeps Mutagen and rsync exclusion decisions in lockstep', () => {
    const mutagenExcludedPaths = representativePaths
      .filter(({ path }) => excludesPath(mutagenPatterns(), path))
      .map(({ path }) => path)
    const rsyncExcludedPaths = representativePaths
      .filter(({ path }) => excludesPath(rsyncPatterns(), path))
      .map(({ path }) => path)

    expect(mutagenExcludedPaths).toEqual(rsyncExcludedPaths)
  })

  it('hoists negations into rsync include rules ahead of every exclude', () => {
    expect(renderRsyncFilterArguments(['*', '!terminal-paste-*', '!remote-paste-*', '.DS_Store'])).toEqual([
      '--filter', '+ terminal-paste-*',
      '--filter', '+ remote-paste-*',
      '--filter', '- *',
      '--filter', '- .DS_Store'
    ])
    expect(renderMutagenIgnoreArguments(['*', '!terminal-paste-*'])).toEqual([
      '--ignore=*',
      '--ignore=!terminal-paste-*'
    ])
  })

  it('never renders the old rsync prefix into a Mutagen pattern', () => {
    expect(mutagenPatterns().some((pattern) => pattern.startsWith('- '))).toBe(false)
    expect(
      renderMutagenIgnoreArguments(DEVBOX_SYNC_EXCLUSIONS).some((argument) =>
        argument.startsWith('--ignore=- ')
      )
    ).toBe(false)
  })
})
