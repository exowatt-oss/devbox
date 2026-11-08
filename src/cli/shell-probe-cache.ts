import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Short-lived memory of endpoints that just failed a `shell ls` probe, so an
 * immediate re-run does not pay the connect timeout again. Purely an
 * optimization: a missing, corrupt or unwritable file behaves as empty.
 */
export const DEVBOX_SHELL_UNREACHABLE_TTL_MS = 60_000
const SCHEMA_VERSION = 1

export type DevboxShellUnreachableEntry = {
  at: number
  error: string
}

export type DevboxShellProbeCache = {
  recentUnreachable(key: string): DevboxShellUnreachableEntry | undefined
  markUnreachable(key: string, error: string): void
  markReachable(key: string): void
}

type CacheFile = {
  schemaVersion: typeof SCHEMA_VERSION
  hosts: Record<string, DevboxShellUnreachableEntry>
}

export function devboxShellProbeCacheKey(endpoint: { username: string; host: string; port: number }): string {
  return `${endpoint.username}@${endpoint.host}:${endpoint.port}`
}

export function createDevboxShellProbeCache(
  file: string,
  options: { ttlMs?: number; now?: () => number } = {}
): DevboxShellProbeCache {
  const ttlMs = options.ttlMs ?? DEVBOX_SHELL_UNREACHABLE_TTL_MS
  const now = options.now ?? Date.now
  const fresh = (entry: DevboxShellUnreachableEntry | undefined): entry is DevboxShellUnreachableEntry =>
    entry !== undefined && now() - entry.at >= 0 && now() - entry.at < ttlMs
  const update = (change: (hosts: Record<string, DevboxShellUnreachableEntry>) => boolean): void => {
    const current = read(file)
    const hosts = Object.fromEntries(Object.entries(current).filter(([, entry]) => fresh(entry)))
    const pruned = Object.keys(hosts).length !== Object.keys(current).length
    if (change(hosts) || pruned) {
      write(file, { schemaVersion: SCHEMA_VERSION, hosts })
    }
  }
  return {
    recentUnreachable: (key) => {
      const entry = read(file)[key]
      return fresh(entry) ? entry : undefined
    },
    markUnreachable: (key, error) => update((hosts) => {
      hosts[key] = { at: now(), error }
      return true
    }),
    markReachable: (key) => update((hosts) => {
      if (!(key in hosts)) {return false}
      delete hosts[key]
      return true
    })
  }
}

function read(file: string): Record<string, DevboxShellUnreachableEntry> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheFile>
    if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.hosts !== 'object' || parsed.hosts === null) {return {}}
    return Object.fromEntries(Object.entries(parsed.hosts).filter(([, entry]) =>
      typeof entry?.at === 'number' && typeof entry.error === 'string'))
  } catch {
    return {}
  }
}

function write(file: string, value: CacheFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } catch {
    // Best effort: losing the memory only costs one more probe.
  }
}
