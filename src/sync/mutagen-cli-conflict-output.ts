import type { MutagenConflictRecord, MutagenConflictSide } from './mutagen-cli-types'

type JsonObject = Record<string, unknown>

type ParsedChange = {
  path: string
  current: MutagenConflictSide
}

function objectValue(value: unknown, message: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as JsonObject
}

function parseEntry(value: unknown): MutagenConflictSide {
  if (value === undefined || value === null) {
    return { kind: 'missing', hash: null }
  }
  const entry = objectValue(value, 'invalid Mutagen conflict entry')
  if (typeof entry.kind !== 'string') {
    throw new Error('invalid Mutagen conflict entry kind')
  }

  if (entry.kind === 'directory' && entry.contents !== undefined && entry.contents !== null) {
    const contents = objectValue(entry.contents, 'invalid Mutagen directory contents')
    for (const child of Object.values(contents)) {
      parseEntry(child)
    }
  }

  if (entry.kind === 'file' && entry.digest !== undefined && typeof entry.digest !== 'string') {
    throw new Error('invalid Mutagen file digest')
  }
  const kind =
    entry.kind === 'directory' || entry.kind === 'file' || entry.kind === 'symlink'
      ? entry.kind
      : 'other'
  const hash = typeof entry.digest === 'string' ? entry.digest : null
  return { kind, hash }
}

function parseChange(value: unknown): ParsedChange {
  const change = objectValue(value, 'invalid Mutagen conflict change')
  if (typeof change.path !== 'string') {
    throw new Error('invalid Mutagen conflict change path')
  }
  const current = parseEntry(change.new)
  parseEntry(change.old)
  return { path: change.path, current }
}

function parseChanges(value: unknown, field: string): readonly ParsedChange[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid Mutagen conflict ${field}`)
  }
  return value.map(parseChange)
}

function pathForChange(root: string, change: ParsedChange): string {
  return change.path.length === 0 ? root : change.path
}

function changeAtPath(
  changes: readonly ParsedChange[],
  root: string,
  path: string
): ParsedChange | undefined {
  return changes.find((change) => pathForChange(root, change) === path)
}

export function parseMutagenConflict(value: unknown): readonly MutagenConflictRecord[] {
  const conflict = objectValue(value, 'invalid Mutagen conflict')
  if (typeof conflict.root !== 'string') {
    throw new Error('invalid Mutagen conflict root')
  }
  const root = conflict.root
  const alphaChanges = parseChanges(conflict.alphaChanges, 'alpha changes')
  const betaChanges = parseChanges(conflict.betaChanges, 'beta changes')
  const paths = new Set<string>()
  for (const change of [...alphaChanges, ...betaChanges]) {
    paths.add(pathForChange(root, change))
  }
  if (paths.size === 0) {
    paths.add(root)
  }

  return [...paths].map((path) => ({
    path,
    alpha: changeAtPath(alphaChanges, root, path)?.current ?? {
      kind: 'missing',
      hash: null
    },
    beta: changeAtPath(betaChanges, root, path)?.current ?? {
      kind: 'missing',
      hash: null
    }
  }))
}
