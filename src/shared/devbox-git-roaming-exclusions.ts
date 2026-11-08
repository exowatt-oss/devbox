export const DEVBOX_GIT_ROAMING_EXCLUSIONS = Object.freeze([
  '.git/', '.git', '.git.devbox-parked/', '.git.devbox-parked', '.devbox/',
  '.pi/agent/sessions/', '.pi/agent/auth.json', '.pi/agent/secrets.env', '.pi/agent/locks/',
  '.worktrees/', '**/.worktrees/', '.ssh/', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/*token*', '**/*secret*', '**/*credentials*', '**/*.iso', '**/*.zip', '**/*.mbox',
  '**/mailboxes/', '**/*.parquet', '**/*.tar', '**/*.tar.gz', '**/*.tgz', '**/*.dmg',
  'node_modules/', '.venv/', 'venv/', 'env/', '__pycache__/', '.cache/', '.npm/',
  '.pnpm-store/', '.yarn/cache/', '.turbo/', '.next/', '.nuxt/', '.svelte-kit/',
  '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', '.nox/', 'coverage/',
  'htmlcov/', 'dist/', 'build/', 'target/', 'out/', '.parcel-cache/', '.vite/',
  '*.egg-info/', '.eggs/', '*.db', '*.sqlite', '*.sqlite3', 'postgres/', 'postgresql/',
  '.local/state/', '*.sock', '*.socket'
] as const)
