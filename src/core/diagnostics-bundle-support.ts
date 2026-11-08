import { existsSync, statSync } from 'node:fs'
import { redactString } from '../shared/redactor-base'

/** Hard upload ceiling shared by collection and the eventual upload client. */
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024

/** Rotated files in age order (newest → oldest). */
export function listRotatedFiles(filePath: string, maxFiles = 10): string[] {
  const files: string[] = []
  for (let index = 0; index < maxFiles; index += 1) {
    const candidate = index === 0 ? filePath : `${filePath}.${index}`
    if (existsSync(candidate)) {
      files.push(candidate)
    }
  }
  return files
}

type RedactorMode = 'client' | 'server'

const CLIENT_ATTR_BLOCKLIST = new Set([
  'env',
  'environment',
  'env_vars',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'bearer',
  'cookie',
  'password',
  'set-cookie',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'proxy-authorization',
  'headers.authorization'
])
const SERVER_ATTR_BLOCKLIST_EXTRA = new Set(['install_id', 'installid', 'distinct_id', 'distinctid'])

function shouldDropAttributeKey(key: string, mode: RedactorMode): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const lower = key.toLowerCase()
  if (CLIENT_ATTR_BLOCKLIST.has(lower)) {
    return true
  }
  if (
    /\b(api[-_]?key|token|secret|password|bearer|authorization|private[-_]?key)\b/i.test(key) ||
    /(apikey|token|secret|password|authorization|bearer|privkey|privatekey)/.test(normalized)
  ) {
    return true
  }
  return mode === 'server' && SERVER_ATTR_BLOCKLIST_EXTRA.has(lower)
}

/**
 * Bundle collection runs a second, server-mode redaction pass. Keep this
 * recursive copy local so the standalone bundle has no observability lane
 * dependency while sharing the canonical string rules.
 */
export function redactDiagnosticValue(
  value: unknown,
  mode: RedactorMode = 'client',
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)
    return value.map((entry) => redactDiagnosticValue(entry, mode, seen))
  }
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!shouldDropAttributeKey(key, mode)) {
        result[key] = redactDiagnosticValue(child, mode, seen)
      }
    }
    return result
  }
  return `[unsupported:${typeof value}]`
}

/** Defensive file-size helper retained for callers that inspect rotated families. */
export function getRotatedFamilySize(filePath: string, maxFiles = 10): number {
  return listRotatedFiles(filePath, maxFiles).reduce((total, path) => {
    try {
      return total + statSync(path).size
    } catch {
      return total
    }
  }, 0)
}
