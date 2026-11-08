import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SPOKE_IDENTITY_RELATIVE, SPOKE_ROOTS_RELATIVE } from './hub-types'

export type SpokeIdentity = {
  schemaVersion: 1
  spokeId: string
  createdAt: string
}

type SpokeRootsFile = {
  schemaVersion: 1
  roots: string[]
}

export function loadOrCreateSpokeIdentity(stateRoot: string): SpokeIdentity {
  ensureStateRoot(stateRoot)
  const identityPath = join(stateRoot, SPOKE_IDENTITY_RELATIVE)
  const existing = readJson(identityPath)
  if (isSpokeIdentity(existing)) {
    chmodSync(identityPath, 0o600)
    return existing
  }
  const identity: SpokeIdentity = {
    schemaVersion: 1,
    spokeId: randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString()
  }
  writePrivateJson(identityPath, identity)
  return identity
}

export function recordSpokeRoot(stateRoot: string, localRoot: string): readonly string[] {
  ensureStateRoot(stateRoot)
  const rootsPath = join(stateRoot, SPOKE_ROOTS_RELATIVE)
  const existing = readJson(rootsPath)
  const roots = isSpokeRootsFile(existing) ? existing.roots : []
  const updated = [...new Set([...roots, localRoot])].sort(compareRoots)
  writePrivateJson(rootsPath, { schemaVersion: 1, roots: updated })
  return updated
}

export function listSpokeRoots(stateRoot: string): readonly string[] {
  const existing = readJson(join(stateRoot, SPOKE_ROOTS_RELATIVE))
  if (!isSpokeRootsFile(existing)) {
    return []
  }
  return [...new Set(existing.roots)].sort(compareRoots)
}

export function hubIdForRoot(remoteRoot: string): string {
  return createHash('sha256').update(remoteRoot, 'utf8').digest('hex').slice(0, 12)
}

function ensureStateRoot(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  chmodSync(stateRoot, 0o700)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

function compareRoots(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isSpokeIdentity(value: unknown): value is SpokeIdentity {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false
  }
  return typeof value.spokeId === 'string' && value.spokeId.length > 0 && typeof value.createdAt === 'string' && value.createdAt.length > 0
}

function isSpokeRootsFile(value: unknown): value is SpokeRootsFile {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.roots) && value.roots.every((root): root is string => typeof root === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
