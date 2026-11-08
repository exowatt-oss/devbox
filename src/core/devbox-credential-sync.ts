import { isAbsolute, join } from 'node:path'
import { createDevboxError } from '../shared/devbox-errors'
import type {
  DevboxCredentialSyncConfig,
  DevboxCredentialSyncRoot,
  DevboxProfileV1
} from '../shared/devbox-types'

export const DEVBOX_MCP_AUTH_ROOT_ID = 'mcp-auth' as const
export const DEVBOX_MCP_AUTH_RELATIVE_DIR = '.mcp-auth' as const
export const DEVBOX_MCP_AUTH_EXCLUDES: readonly string[] = [
  '*_code_verifier*.txt',
  '*_lock*.json',
  '*_debug*.log',
  '*.stale-*',
  '.DS_Store'
]
export const DEVBOX_CREDENTIAL_SYNC_MAX_ENTRY_COUNT = 20_000 as const

const CREDENTIAL_ROOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !value.includes('\u0000') &&
  isAbsolute(value.trim())

const validExclude = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.trim().replaceAll('\\', '/')
  return (
    normalized.length > 0 &&
    !normalized.includes('\u0000') &&
    !normalized.startsWith('/') &&
    !normalized.split('/').some((part) => part === '..')
  )
}

const validRoot = (value: unknown): value is DevboxCredentialSyncRoot => {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !CREDENTIAL_ROOT_ID.test(value.id) ||
    !absolutePath(value.localRoot) ||
    !absolutePath(value.remoteRoot) ||
    !Array.isArray(value.excludes)
  ) {
    return false
  }
  return value.excludes.every(validExclude)
}

const unique = (values: readonly string[]): string[] => [...new Set(values)]

export const defaultDevboxCredentialSyncConfig = (): DevboxCredentialSyncConfig => ({
  enabled: false,
  roots: []
})

export function mcpAuthCredentialRoot(
  localHome: string,
  remoteHome: string,
  excludes?: readonly string[]
): DevboxCredentialSyncRoot {
  return {
    id: DEVBOX_MCP_AUTH_ROOT_ID,
    localRoot: join(localHome, DEVBOX_MCP_AUTH_RELATIVE_DIR),
    remoteRoot: join(remoteHome, DEVBOX_MCP_AUTH_RELATIVE_DIR),
    excludes: unique([...DEVBOX_MCP_AUTH_EXCLUDES, ...(excludes ?? [])])
  }
}

export function validateDevboxCredentialSyncConfig(
  input: unknown
): input is DevboxCredentialSyncConfig {
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

export function normalizeDevboxCredentialSyncConfig(
  input: DevboxCredentialSyncConfig
): DevboxCredentialSyncConfig {
  return {
    enabled: input.enabled,
    roots: input.roots
      .map((root) => ({ ...root, excludes: unique(root.excludes) }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}

const credentialRootError = (
  field: 'credential-root-id' | 'credential-root-absolute-paths' | 'credential-root-exclude'
): never => {
  throw createDevboxError('operation_conflict', { context: { field } })
}

function validateRootForEnable(root: DevboxCredentialSyncRoot): void {
  if (!object(root) || typeof root.id !== 'string' || !CREDENTIAL_ROOT_ID.test(root.id)) {
    credentialRootError('credential-root-id')
  }
  if (!absolutePath(root.localRoot) || !absolutePath(root.remoteRoot)) {
    credentialRootError('credential-root-absolute-paths')
  }
  if (!Array.isArray(root.excludes) || !root.excludes.every(validExclude)) {
    credentialRootError('credential-root-exclude')
  }
}

export function enableDevboxCredentialSync(
  profile: DevboxProfileV1,
  root: DevboxCredentialSyncRoot
): DevboxProfileV1 {
  validateRootForEnable(root)
  const current = profile.credentialSync ?? defaultDevboxCredentialSyncConfig()
  const roots = [...current.roots.filter((candidate) => candidate.id !== root.id), root]
  return {
    ...profile,
    credentialSync: normalizeDevboxCredentialSyncConfig({
      enabled: true,
      roots
    })
  }
}

export function disableDevboxCredentialSync(profile: DevboxProfileV1): DevboxProfileV1 {
  const current = profile.credentialSync ?? defaultDevboxCredentialSyncConfig()
  return {
    ...profile,
    credentialSync: {
      enabled: false,
      roots: current.roots
    }
  }
}
