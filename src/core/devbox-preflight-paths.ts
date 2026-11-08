import type { DevboxProfileV1 } from '../shared/devbox-types'
import { DevboxPathMapper, findDevboxCaseCollisionCandidates } from './devbox-path-mapper'
import {
  errorFor,
  inventoryEntries,
  makeCheck,
  type DevboxPreflightExec
} from './devbox-preflight-checks'
import type {
  DevboxExecRequest,
  DevboxInventoryEntry,
  DevboxPathIssue,
  DevboxPreflightCheck
} from './devbox-preflight-types'

const inventoryKindLine = [
  '  k="symlink" if stat.S_ISLNK(m) else "directory" if stat.S_ISDIR(m) else ',
  '"file" if stat.S_ISREG(m) else "fifo" if stat.S_ISFIFO(m) else ',
  '"device" if stat.S_ISCHR(m) or stat.S_ISBLK(m) else ',
  '"socket" if stat.S_ISSOCK(m) else "unknown"'
].join('')
const inventoryScript = [
  'import fnmatch,json,os,stat,sys,unicodedata',
  'root=os.path.abspath(sys.argv[1]);patterns=json.loads(sys.argv[2]);prune=sys.argv[3]=="1";seen={};emitted=set();prefixes=[];wildcards=[]',
  'for raw in patterns:',
  ' p=raw.replace("\\\\","/").rstrip("/")',
  ' p=p[3:] if p.startswith("**/") else p',
  ' (wildcards if any(c in p for c in "*?[") else prefixes).append(p)',
  'def ignored(r):',
  ' padded="/"+r+"/"',
  ' if any("/"+p+"/" in padded for p in prefixes):return True',
  ' return any(fnmatch.fnmatch(r,p) or fnmatch.fnmatch(r,"*/"+p) or fnmatch.fnmatch(r,"*/"+p+"/*") for p in wildcards)',
  'def emit(v):',
  ' if v["path"] not in emitted:print(json.dumps(v,ensure_ascii=False));emitted.add(v["path"])',
  'def scan_ignored(path,relbase,depth=2):',
  ' if depth<0:return',
  ' try:children=os.scandir(path)',
  ' except OSError:return',
  ' for child in children:',
  '  try:m=child.stat(follow_symlinks=False).st_mode',
  '  except OSError:continue',
  inventoryKindLine,
  '  value={"path":child.path,"kind":k,"target":os.readlink(child.path) if k=="symlink" else None}',
  '  if k=="symlink" or k not in ("file","directory"):emit(value)',
  '  elif k=="directory" and depth>0:scan_ignored(child.path,relbase+"/"+child.name,depth-1)',
  ' children.close()',
  'for b,ds,fs in os.walk(root,followlinks=False):',
  ' if prune:',
  '  for d in list(ds):',
  '   if ignored(os.path.relpath(os.path.join(b,d),root).replace(os.sep,"/")):scan_ignored(os.path.join(b,d),"",2);ds.remove(d)',
  ' for n in ds+fs:',
  '  p=os.path.join(b,n);r=os.path.relpath(p,root).replace(os.sep,"/")',
  '  try:m=os.lstat(p).st_mode',
  '  except OSError:continue',
  inventoryKindLine,
  '  value={"path":p,"kind":k,"target":os.readlink(p) if k=="symlink" else None}',
  '  key=unicodedata.normalize("NFD",r).casefold()',
  '  if ignored(r) and k in ("file","directory"):',
  '   if key in seen and key not in emitted:emit(seen[key]);emit(value)',
  '   else:seen[key]=value',
  '  else:emit(value)',
  ''
].join('\n')

function inventoryCommand(root: string, excludes: readonly string[], pruneIgnored: boolean): DevboxExecRequest {
  return { command: 'python3', args: ['-c', inventoryScript, root, JSON.stringify(excludes), pruneIgnored ? '1' : '0'] }
}
function createPathMapper(profile: DevboxProfileV1): DevboxPathMapper { return new DevboxPathMapper(profile) }
function relativePath(path: string, root: string): string | undefined {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path === root ? '.' : path.startsWith(prefix) ? path.slice(prefix.length).replaceAll('\\', '/') : undefined
}
function globMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '')
  const alternatives = normalized.startsWith('**/') ? [normalized.slice(3), normalized] : [normalized]
  return alternatives.some((value) => {
    const candidate = value.replace(/\/+$/u, '')
    const regex = `^${candidate.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('**', '.*').replaceAll('*', '[^/]*')}(?:/.*)?$`
    return new RegExp(regex, 'u').test(path)
  })
}
function ignored(profile: DevboxProfileV1, path: string, side: 'local' | 'remote'): boolean {
  const root = side === 'local' ? profile.roots.localRoot : profile.roots.remoteRoot
  const relative = relativePath(path, root)
  if (!relative) {return false}
  return profile.sync.excludes.some((pattern) => globMatches(relative, pattern))
}
function addCaseCollisionIssues(
  issues: DevboxPathIssue[],
  localPaths: readonly string[],
  remotePaths: readonly string[],
  profile: DevboxProfileV1
): ReadonlySet<string> {
  const localCandidates = findDevboxCaseCollisionCandidates(localPaths, 'local')
  const remoteCandidates = findDevboxCaseCollisionCandidates(remotePaths, 'remote')
  const add = (candidate: (typeof localCandidates)[number], side: 'local' | 'remote'): void => {
    const allIgnored = candidate.paths.every((path) => ignored(profile, path, side))
    issues.push({
      path: candidate.paths[0]!,
      reason: allIgnored ? 'ignored-case-or-unicode-collision' : 'case-or-unicode-collision',
      severity: allIgnored ? 'warn' : 'block',
      candidates: candidate.paths
    })
  }
  for (const candidate of localCandidates) {add(candidate, 'local')}
  for (const candidate of remoteCandidates) {add(candidate, 'remote')}
  return new Set(localCandidates.flatMap((candidate) => candidate.paths))
}
const remotePathIndexKey = (path: string): string => path.normalize('NFD').toLowerCase()
function addUnsupportedEntryIssues(
  issues: DevboxPathIssue[],
  entries: readonly DevboxInventoryEntry[],
  profile: DevboxProfileV1,
  mapper: DevboxPathMapper,
  side: 'local-to-remote' | 'remote-to-local'
): void {
  const sourceSide = side === 'local-to-remote' ? 'local' : 'remote'
  for (const entry of entries) {
    const isIgnored = ignored(profile, entry.path, sourceSide)
    if (['device', 'fifo', 'socket', 'unknown'].includes(entry.kind)) {
      issues.push({ path: entry.path, reason: isIgnored ? `ignored-unsupported-${entry.kind}` : `unsupported-${entry.kind}`, severity: 'warn' })
    }
    if (entry.kind === 'symlink' && entry.target && mapper.relocateSymlinkTarget(entry.target, side).status === 'out-of-root') {
      issues.push({ path: entry.path, reason: isIgnored ? 'ignored-out-of-root-link' : 'out-of-root-link', severity: 'warn' })
    }
  }
}

export async function runPathChecks(
  profile: DevboxProfileV1,
  exec: DevboxPreflightExec,
  checks: DevboxPreflightCheck[],
  issues: DevboxPathIssue[]
): Promise<void> {
  const localResult = await exec('local', inventoryCommand(profile.roots.localRoot, profile.sync.excludes, true))
  const remoteResult = await exec('remote', inventoryCommand(profile.roots.remoteRoot, profile.sync.excludes, false))
  const local = inventoryEntries(localResult)
  const remote = inventoryEntries(remoteResult)
  const mapper = createPathMapper(profile)
  const localPaths = local.map((entry) => entry.path)
  const remotePaths = remote.map((entry) => entry.path)
  const localCollisionPaths = addCaseCollisionIssues(issues, localPaths, remotePaths, profile)
  const remoteByComparablePath = new Map<string, DevboxInventoryEntry>()
  for (const entry of remote) {
    const key = remotePathIndexKey(entry.path)
    if (!remoteByComparablePath.has(key)) {remoteByComparablePath.set(key, entry)}
  }
  addUnsupportedEntryIssues(issues, local, profile, mapper, 'local-to-remote')
  addUnsupportedEntryIssues(issues, remote, profile, mapper, 'remote-to-local')
  for (const entry of local) {
    if (localCollisionPaths.has(entry.path)) {continue}
    const mapped = mapper.map(entry.path)
    if (mapped.status !== 'mapped') {continue}
    const counterpart = remoteByComparablePath.get(remotePathIndexKey(mapped.mappedPath))
    if (counterpart && counterpart.path !== mapped.mappedPath) {
      const allIgnored = ignored(profile, entry.path, 'local') && ignored(profile, counterpart.path, 'remote')
      issues.push({ path: mapped.mappedPath, reason: allIgnored ? 'ignored-case-or-unicode-collision' : 'case-or-unicode-collision', severity: allIgnored ? 'warn' : 'block', candidates: [entry.path, counterpart.path] })
    }
    if (counterpart && counterpart.kind !== entry.kind) {
      const allIgnored = ignored(profile, entry.path, 'local') && ignored(profile, counterpart.path, 'remote')
      issues.push({ path: mapped.mappedPath, reason: 'path-type-conflict', severity: allIgnored ? 'warn' : 'block', candidates: [entry.path, counterpart.path] })
    }
  }
  const inventoryOk = localResult?.exitCode === 0 && remoteResult?.exitCode === 0
  if (!inventoryOk) {issues.push({ path: profile.roots.localRoot, reason: 'path-inventory-failed', severity: 'block', candidates: [profile.roots.localRoot, profile.roots.remoteRoot] })}
  const blocking = issues.filter((issue) => issue.severity === 'block').length
  const warning = issues.length - blocking
  const status = !inventoryOk ? 'fail' : blocking ? 'fail' : warning ? 'warn' : 'pass'
  checks.push(makeCheck(
    'path-safety',
    status,
    inventoryOk
      ? 'Hard collisions inside the sync scope block. Out-of-root links, unsupported entries, and collisions entirely inside ignored paths are warnings listed in --json.'
      : 'Path inventory could not be completed; treat the path-safety result as block and inspect the command evidence.',
    !inventoryOk || blocking > 0,
    { issueCount: issues.length, blockingIssueCount: blocking, warningIssueCount: warning, inventory: inventoryOk ? 'pass' : 'block', pathSafety: inventoryOk ? (blocking > 0 ? 'block' : warning > 0 ? 'warn' : 'pass') : 'block', localExitCode: localResult?.exitCode ?? -1, remoteExitCode: remoteResult?.exitCode ?? -1, localStderr: localResult?.stderr?.slice(0, 512) ?? '', remoteStderr: remoteResult?.stderr?.slice(0, 512) ?? '' },
    !inventoryOk || blocking > 0 ? errorFor('path-safety') : undefined
  ))
}
