export const DEVBOX_RSYNC_LEAN_FILTER = [
  '- node_modules/',
  '- .venv/',
  '- venv/',
  '- env/',
  '- __pycache__/',
  '- *.pyc',
  '- *.pyo',
  '- *.pyd',
  '- .pytest_cache/',
  '- .mypy_cache/',
  '- .ruff_cache/',
  '- .tox/',
  '- .nox/',
  '- .hypothesis/',
  '- .cache/',
  '- .npm/',
  '- .pnpm-store/',
  '- .yarn/cache/',
  '- .turbo/',
  '- .next/',
  '- .nuxt/',
  '- .svelte-kit/',
  '- coverage/',
  '- htmlcov/',
  '- .coverage',
  '- .coverage.*',
  '- dist/',
  '- build/',
  '- target/',
  '- out/',
  '- .parcel-cache/',
  '- .vite/',
  '- .eslintcache',
  '- *.egg-info/',
  '- .eggs/',
  '- .DS_Store',
  '- .AppleDouble/',
  '- .rsync-partial/'
] as const

export const DEVBOX_CANONICAL_LEAN_FILTER = DEVBOX_RSYNC_LEAN_FILTER

export const DEVBOX_RSYNC_BASE_OPTIONS = [
  '--archive',
  '--hard-links',
  '--sparse',
  '--no-owner',
  '--no-group',
  '--partial',
  '--partial-dir=.rsync-partial',
  '--timeout=120',
  '--compress',
  '--compress-choice=zstd',
  '--protect-args'
] as const

export const DEVBOX_RSYNC_TRACKED_OPTIONS = DEVBOX_RSYNC_BASE_OPTIONS

export const filterMatches = (path: string): boolean => {
  const parts = path.split('/')
  const file = parts.at(-1) ?? ''
  const excludedDirectories = [
    'node_modules',
    '.venv',
    'venv',
    'env',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',
    '.nox',
    '.hypothesis',
    '.cache',
    '.npm',
    '.pnpm-store',
    '.turbo',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'coverage',
    'htmlcov',
    'dist',
    'build',
    'target',
    'out',
    '.parcel-cache',
    '.vite',
    '.AppleDouble',
    '.eggs'
  ]

  return (
    parts.some((part) => excludedDirectories.includes(part)) ||
    /^(?:\.(?:coverage(?:\..*)?|eslintcache|DS_Store))$/.test(file) ||
    /\.(?:pyc|pyo|pyd|egg-info)$/.test(file) ||
    path === '.rsync-partial' ||
    path.startsWith('.rsync-partial/')
  )
}
