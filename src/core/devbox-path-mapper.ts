import { dirname, resolve } from 'node:path'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import type { DevboxProfileV1 } from '../shared/devbox-types'

export type DevboxPathDirection = 'local-to-remote' | 'remote-to-local'
export type DevboxPathSide = 'local' | 'remote'
export type DevboxPathMapOptions = Readonly<{
  syncClassId?: string
  knownPaths?: readonly string[]
  symlinkPath?: string
}>
type DevboxPathErrorResult = { sourcePath: string; error: DevboxError }
export type DevboxPathMappingResult =
  | {
      status: 'mapped'
      sourcePath: string
      mappedPath: string
      direction: DevboxPathDirection
      syncClassId: string
      pathMapId?: string
    }
  | (DevboxPathErrorResult & { status: 'outside-root' | 'unmapped-path-class' })
  | (DevboxPathErrorResult & {
      status: 'invalid'
      reason: 'malformed-profile' | 'malformed-path' | 'ambiguous-map' | 'case-collision'
      collisionCandidates?: readonly DevboxCaseCollisionCandidate[]
    })

export type DevboxCaseCollisionCandidate = Readonly<{
  paths: readonly string[]
  kind: 'case' | 'unicode-normalization' | 'case-and-unicode'
}>
export type DevboxSymlinkRelocationResult =
  | { status: 'relative-in-root'; target: string; relocatedTarget: string }
  | { status: 'absolute-in-root'; target: string; relocatedTarget: string }
  | { status: 'out-of-root'; target: string; error: DevboxError }
  | { status: 'invalid'; target: string; error: DevboxError }
export type DevboxGitPointerRelocationResult =
  | { status: 'relative-in-root'; content: string; relocatedContent: string }
  | { status: 'absolute-in-root'; content: string; relocatedContent: string }
  | { status: 'out-of-root'; content: string; error: DevboxError }
  | { status: 'invalid'; content: string; error: DevboxError }

type ParsedPath = { segments: string[] }

const error = (field: string, code: 'unknown' | 'operation_conflict' = 'unknown'): DevboxError =>
  createDevboxError(code, { context: { field } })
const compareSegment = (value: string, side: DevboxPathSide): string =>
  side === 'local' ? value.normalize('NFD').toLowerCase() : value
const parseAbsolute = (value: string): ParsedPath | null => {
  if (!value || value.includes('\u0000') || !value.startsWith('/')) {
    return null
  }
  const segments = value.split('/').filter((segment) => segment && segment !== '.')
  return segments.includes('..') ? null : { segments }
}
const parseRelative = (value: string): string[] | null => {
  if (!value || value.includes('\u0000') || value.startsWith('/')) {
    return null
  }
  const segments = value.split('/')
  return segments.some((segment) => !segment || segment === '..')
    ? null
    : segments.filter((segment) => segment !== '.')
}
const joinPath = (root: string, segments: readonly string[]): string => {
  const parsed = parseAbsolute(root)
  return parsed && parsed.segments.length > 0
    ? `/${[...parsed.segments, ...segments].join('/')}`
    : `/${segments.join('/')}`
}
const prefixMatches = (
  candidate: readonly string[],
  prefix: readonly string[],
  side: DevboxPathSide
): boolean =>
  candidate.length >= prefix.length &&
  prefix.every(
    (segment, index) => compareSegment(candidate[index]!, side) === compareSegment(segment, side)
  )
const relativeTargetStaysInRoot = (target: string): boolean => {
  let depth = 0
  return target
    .split('/')
    .every((segment) =>
      segment === '..' ? depth-- > 0 : !segment || segment === '.' || ++depth > 0
    )
}
const relativeTargetResolvesInRoot = (
  target: string,
  symlinkPath: string,
  root: string,
  side: DevboxPathSide
): boolean => {
  const rootSegments = parseAbsolute(root)?.segments
  const resolvedSegments = parseAbsolute(resolve(dirname(symlinkPath), target))?.segments
  return !!rootSegments && !!resolvedSegments && prefixMatches(resolvedSegments, rootSegments, side)
}
const profileIsUsable = (profile: DevboxProfileV1): boolean => {
  const roots = [parseAbsolute(profile.roots.localRoot), parseAbsolute(profile.roots.remoteRoot)]
  const classIds = new Set(profile.sync.classes.map((item) => item.id))
  return (
    roots.every((root) => root !== null) &&
    profile.sync.defaultClassId.length > 0 &&
    classIds.has(profile.sync.defaultClassId) &&
    profile.pathMap.every(
      (entry) =>
        parseRelative(entry.localRelativePath) !== null &&
        parseRelative(entry.remoteRelativePath) !== null &&
        classIds.has(entry.syncClassId)
    )
  )
}

export function findDevboxCaseCollisionCandidates(
  paths: readonly string[],
  side: DevboxPathSide = 'local'
): readonly DevboxCaseCollisionCandidate[] {
  const groups = new Map<string, string[]>()
  for (const value of paths) {
    const parsed = parseAbsolute(value)
    if (!parsed) {
      continue
    }
    const normalized = parsed.segments.join('/').normalize(side === 'local' ? 'NFD' : 'NFC')
    const key = side === 'local' ? normalized.toLowerCase() : normalized
    const group = groups.get(key) ?? []
    if (!group.includes(value)) {
      group.push(value)
    }
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const nfc = group.map((value) => value.normalize('NFC'))
      const nfd = group.map((value) => value.normalize('NFD'))
      const differsByCase =
        new Set(nfc.map((value) => value.toLowerCase())).size === 1 && new Set(nfc).size > 1
      const differsByUnicode = new Set(nfc).size === 1 && new Set(nfd).size > 1
      const kind =
        differsByCase && differsByUnicode
          ? 'case-and-unicode'
          : differsByCase
            ? 'case'
            : 'unicode-normalization'
      return { paths: [...group], kind }
    })
}

export class DevboxPathMapper {
  constructor(readonly profile: DevboxProfileV1) {}

  map(localPath: string, options?: DevboxPathMapOptions): DevboxPathMappingResult {
    return this.mapPath(localPath, 'local-to-remote', options)
  }
  unmap(remotePath: string, options?: DevboxPathMapOptions): DevboxPathMappingResult {
    return this.mapPath(remotePath, 'remote-to-local', options)
  }
  mapPath(
    sourcePath: string,
    direction: DevboxPathDirection,
    options?: DevboxPathMapOptions
  ): DevboxPathMappingResult {
    if (!profileIsUsable(this.profile)) {
      return {
        status: 'invalid',
        sourcePath,
        error: error('path-profile'),
        reason: 'malformed-profile'
      }
    }
    const local = direction === 'local-to-remote'
    const sourceSide: DevboxPathSide = local ? 'local' : 'remote'
    const sourceRoot = local ? this.profile.roots.localRoot : this.profile.roots.remoteRoot
    const targetRoot = local ? this.profile.roots.remoteRoot : this.profile.roots.localRoot
    const parsed = parseAbsolute(sourcePath)
    const root = parseAbsolute(sourceRoot)
    if (!parsed || !root) {
      return { status: 'invalid', sourcePath, error: error('path-input'), reason: 'malformed-path' }
    }
    const collisionCandidates = findDevboxCaseCollisionCandidates(
      [sourcePath, ...(options?.knownPaths ?? [])],
      sourceSide
    ).filter((candidate) => candidate.paths.includes(sourcePath))
    if (collisionCandidates.length > 0) {
      return {
        status: 'invalid',
        sourcePath,
        error: error('path-case-collision', 'operation_conflict'),
        reason: 'case-collision',
        collisionCandidates
      }
    }
    if (!prefixMatches(parsed.segments, root.segments, sourceSide)) {
      return { status: 'outside-root', sourcePath, error: error('path-outside-root') }
    }
    const requestedClass = options?.syncClassId
    const classIds = new Set(this.profile.sync.classes.map((item) => item.id))
    if (requestedClass !== undefined && !classIds.has(requestedClass)) {
      return { status: 'unmapped-path-class', sourcePath, error: error('path-class') }
    }
    const entries = this.profile.pathMap.map((entry) => ({
      entry,
      source: parseRelative(local ? entry.localRelativePath : entry.remoteRelativePath)!,
      target: parseRelative(local ? entry.remoteRelativePath : entry.localRelativePath)!
    }))
    const sourceSuffix = parsed.segments.slice(root.segments.length)
    const matches = entries.filter((candidate) =>
      prefixMatches(sourceSuffix, candidate.source, sourceSide)
    )
    const longest = matches.reduce(
      (length, candidate) => Math.max(length, candidate.source.length),
      -1
    )
    const best = matches.filter((candidate) => candidate.source.length === longest)
    if (best.length > 1) {
      const identities = new Set(
        best.map((candidate) => `${candidate.target.join('/')}\u0000${candidate.entry.syncClassId}`)
      )
      if (identities.size > 1) {
        return {
          status: 'invalid',
          sourcePath,
          error: error('path-map-ambiguous', 'operation_conflict'),
          reason: 'ambiguous-map'
        }
      }
    }
    const selected = best[0]
    if (selected && requestedClass !== undefined && selected.entry.syncClassId !== requestedClass) {
      return { status: 'unmapped-path-class', sourcePath, error: error('path-class') }
    }
    const suffix = selected
      ? [...selected.target, ...sourceSuffix.slice(selected.source.length)]
      : sourceSuffix
    const syncClassId =
      selected?.entry.syncClassId ?? requestedClass ?? this.profile.sync.defaultClassId
    return {
      status: 'mapped',
      sourcePath,
      mappedPath: joinPath(targetRoot, suffix),
      direction,
      syncClassId,
      ...(selected ? { pathMapId: selected.entry.id } : {})
    }
  }

  relocateSymlinkTarget(
    target: string,
    direction: DevboxPathDirection,
    options?: DevboxPathMapOptions
  ): DevboxSymlinkRelocationResult {
    if (!target || target.includes('\u0000')) {
      return { status: 'invalid', target, error: error('symlink-target') }
    }
    if (!target.startsWith('/')) {
      const local = direction === 'local-to-remote'
      const sourceRoot = local ? this.profile.roots.localRoot : this.profile.roots.remoteRoot
      const sourceSide: DevboxPathSide = local ? 'local' : 'remote'
      const staysInRoot =
        options?.symlinkPath === undefined
          ? relativeTargetStaysInRoot(target)
          : relativeTargetResolvesInRoot(target, options.symlinkPath, sourceRoot, sourceSide)
      if (!staysInRoot) {
        return { status: 'out-of-root', target, error: error('path-outside-root') }
      }
      return { status: 'relative-in-root', target, relocatedTarget: target }
    }
    const mapped = this.mapPath(target, direction, options)
    if (mapped.status === 'mapped') {
      return { status: 'absolute-in-root', target, relocatedTarget: mapped.mappedPath }
    }
    if (mapped.status === 'outside-root') {
      return { status: 'out-of-root', target, error: mapped.error }
    }
    return { status: 'invalid', target, error: mapped.error }
  }

  relocateGitWorktreePointer(
    content: string,
    direction: DevboxPathDirection,
    options?: DevboxPathMapOptions
  ): DevboxGitPointerRelocationResult {
    const lineEnding = content.endsWith('\r\n') ? '\r\n' : content.endsWith('\n') ? '\n' : ''
    const body = lineEnding ? content.slice(0, -lineEnding.length) : content
    const match = /^gitdir:([ \t]*)(.+)$/.exec(body)
    if (!match || body.includes('\r') || body.includes('\n')) {
      return { status: 'invalid', content, error: error('git-worktree-pointer') }
    }
    const target = match[2]!
    if (!target.startsWith('/')) {
      return { status: 'relative-in-root', content, relocatedContent: content }
    }
    const mapped = this.mapPath(target, direction, options)
    if (mapped.status === 'mapped') {
      return {
        status: 'absolute-in-root',
        content,
        relocatedContent: `gitdir:${match[1]}${mapped.mappedPath}${lineEnding}`
      }
    }
    if (mapped.status === 'outside-root') {
      return { status: 'out-of-root', content, error: mapped.error }
    }
    return { status: 'invalid', content, error: mapped.error }
  }
}
