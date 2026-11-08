import { isAbsolute } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import type {
  DevboxPasteSyncConfig,
  DevboxPasteSyncRoot,
  DevboxProfileV1
} from '../shared/devbox-types'

/**
 * A terminal host writes clipboard images to the control machine's temp directory as
 * `terminal-paste-<ts>-<uuid>.png` and pastes that absolute path into the terminal. When
 * the terminal is a remote one the agent reads the path on the remote host, so the file
 * has to exist there at the same absolute path. This root mirrors just those files.
 */
export const DEVBOX_PASTE_ROOT_ID = 'clipboard' as const
export const DEVBOX_PASTE_PATTERNS: readonly string[] = ['terminal-paste-*']
/** The temp root itself is never scanned deeply: `*` is ignored and only patterns are un-ignored. */
export const DEVBOX_PASTE_SYNC_MAX_ENTRY_COUNT = 50_000 as const

const PASTE_ROOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !value.includes('\u0000') &&
  isAbsolute(value.trim())

/**
 * Patterns name files directly inside the root: no separators, no negation, no `..`.
 * They are rendered as ignore negations (`!pattern`), so the syntax must stay plain.
 */
export const validPastePattern = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.trim()
  return (
    normalized.length > 0 &&
    !normalized.includes('\u0000') &&
    !normalized.includes('/') &&
    !normalized.includes('\\') &&
    !normalized.startsWith('!') &&
    !normalized.startsWith('#') &&
    normalized !== '.' &&
    normalized !== '..' &&
    normalized !== '*' &&
    normalized !== '**'
  )
}

const validRoot = (value: unknown): value is DevboxPasteSyncRoot => {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !PASTE_ROOT_ID.test(value.id) ||
    !absolutePath(value.localRoot) ||
    !absolutePath(value.remoteRoot) ||
    !Array.isArray(value.patterns) ||
    value.patterns.length === 0
  ) {
    return false
  }
  return value.patterns.every(validPastePattern)
}

const unique = (values: readonly string[]): string[] => [...new Set(values)]

export const defaultDevboxPasteSyncConfig = (): DevboxPasteSyncConfig => ({
  enabled: false,
  roots: []
})

/** Strip a trailing separator (macOS `$TMPDIR` ends in `/`), keeping a bare root intact. */
export function normalizePasteRootPath(path: string): string {
  const trimmed = path.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/u, '') : trimmed
}

export function clipboardPasteRoot(
  localTempDir: string,
  remoteTempDir?: string,
  patterns?: readonly string[]
): DevboxPasteSyncRoot {
  const localRoot = normalizePasteRootPath(localTempDir)
  return {
    id: DEVBOX_PASTE_ROOT_ID,
    localRoot,
    remoteRoot: remoteTempDir === undefined ? localRoot : normalizePasteRootPath(remoteTempDir),
    patterns: unique([...DEVBOX_PASTE_PATTERNS, ...(patterns ?? [])])
  }
}

export function validateDevboxPasteSyncConfig(input: unknown): input is DevboxPasteSyncConfig {
  if (!object(input) || typeof input.enabled !== 'boolean' || !Array.isArray(input.roots)) {
    return false
  }
  const ids = new Set<string>()
  for (const root of input.roots) {
    if (!validRoot(root) || ids.has(root.id)) {
      return false
    }
    ids.add(root.id)
  }
  return true
}

export function normalizeDevboxPasteSyncConfig(input: DevboxPasteSyncConfig): DevboxPasteSyncConfig {
  return {
    enabled: input.enabled,
    roots: input.roots
      .map((root) => ({ ...root, patterns: unique(root.patterns) }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}

const pasteRootError = (
  field: 'paste-root-id' | 'paste-root-absolute-paths' | 'paste-root-pattern'
): never => {
  throw createDevboxError('operation_conflict', { context: { field } })
}

function validateRootForEnable(root: DevboxPasteSyncRoot): void {
  if (!object(root) || typeof root.id !== 'string' || !PASTE_ROOT_ID.test(root.id)) {
    pasteRootError('paste-root-id')
  }
  if (!absolutePath(root.localRoot) || !absolutePath(root.remoteRoot)) {
    pasteRootError('paste-root-absolute-paths')
  }
  if (
    !Array.isArray(root.patterns) ||
    root.patterns.length === 0 ||
    !root.patterns.every(validPastePattern)
  ) {
    pasteRootError('paste-root-pattern')
  }
}

export function enableDevboxPasteSync(
  profile: DevboxProfileV1,
  root: DevboxPasteSyncRoot
): DevboxProfileV1 {
  validateRootForEnable(root)
  const current = profile.pasteSync ?? defaultDevboxPasteSyncConfig()
  const roots = [...current.roots.filter((candidate) => candidate.id !== root.id), root]
  return {
    ...profile,
    pasteSync: normalizeDevboxPasteSyncConfig({ enabled: true, roots })
  }
}

export function disableDevboxPasteSync(profile: DevboxProfileV1): DevboxProfileV1 {
  const current = profile.pasteSync ?? defaultDevboxPasteSyncConfig()
  return {
    ...profile,
    pasteSync: { enabled: false, roots: current.roots }
  }
}

/**
 * Ignore everything in the root, then un-ignore the paste patterns. Mutagen applies
 * negations in order; the rsync adapter reorders includes ahead of excludes itself.
 */
export function pasteSyncExcludes(root: DevboxPasteSyncRoot): string[] {
  return ['*', ...unique(root.patterns).map((pattern) => `!${pattern}`)]
}
