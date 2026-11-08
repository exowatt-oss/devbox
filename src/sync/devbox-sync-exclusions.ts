/**
 * Syntax-neutral exclusion patterns shared by every sync backend.
 *
 * Keep backend syntax out of this list. Each adapter owns rendering these
 * logical paths for its command-line tool.
 */
export const DEVBOX_SYNC_EXCLUSIONS = Object.freeze([
  'node_modules/',
  '.venv/',
  'venv/',
  'env/',
  '__pycache__/',
  '*.pyc',
  '*.pyo',
  '*.pyd',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '.nox/',
  '.hypothesis/',
  '.cache/',
  '.npm/',
  '.pnpm-store/',
  '.yarn/cache/',
  '.turbo/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  'coverage/',
  'htmlcov/',
  '.coverage',
  '.coverage.*',
  'dist/',
  'build/',
  'target/',
  'out/',
  '.parcel-cache/',
  '.vite/',
  '.eslintcache',
  '*.egg-info/',
  '.eggs/',
  '.DS_Store',
  '.AppleDouble/',
  '.rsync-partial/',
  '.git/',
  '.git',
  '.hg/',
  '.svn/',
  '.pi/agent/sessions/',
  '.pi/agent/auth.json',
  '.pi/agent/secrets.env',
  '.pi/agent/locks/',
  '.ssh/',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*token*',
  '**/*secret*',
  '**/*credentials*',
  '.local/state/',
  '.local/share/**/sockets/',
  '*.db',
  '*.sqlite',
  '*.sqlite3',
  '*.sock',
  '*.socket',
  'postgres/',
  'postgresql/'
] as const)

function uniquePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns)]
}

export function renderMutagenIgnoreArguments(patterns: readonly string[]): string[] {
  return uniquePatterns(patterns).map((pattern) => `--ignore=${pattern}`)
}

/**
 * `!pattern` is a negation (un-ignore). Mutagen resolves negations by order, rsync by
 * first match, so includes are emitted ahead of every exclude to mean the same thing.
 */
export function renderRsyncFilterArguments(patterns: readonly string[]): string[] {
  const unique = uniquePatterns(patterns)
  const includes = unique.filter((pattern) => pattern.startsWith('!'))
  const excludes = unique.filter((pattern) => !pattern.startsWith('!'))
  return [
    ...includes.flatMap((pattern) => ['--filter', `+ ${pattern.slice(1)}`]),
    ...excludes.flatMap((pattern) => ['--filter', `- ${pattern}`])
  ]
}
