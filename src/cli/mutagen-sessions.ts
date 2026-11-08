import type { MutagenSessionEndpoint, MutagenSessionView } from './hub-types'
import type { ServiceExec } from './mutagen-service'
import { DEVBOX_SYNC_BACKEND_LABEL, DEVBOX_SYNC_PROFILE_LABEL, DEVBOX_SYNC_ROOT_CLASS_LABEL } from '../sync/devbox-sync-backend'

/** A Devbox-owned auxiliary root (paste or credentials) that syncs outside the profile's main root pair. */
export type AuxiliarySessionRoot = { rootClass: 'paste' | 'credentials'; localRoot: string; remoteRoot: string }

type SessionFilter = {
  profileId?: string
  hub?: { host: string; user: string; remoteRoot: string; localRoot: string; auxiliaryRoots?: readonly AuxiliarySessionRoot[] }
}

export type ListMutagenSessionViewsOptions = {
  binaryPath: string
  dataDirectory: string
  profileId?: string
  hub?: SessionFilter['hub']
  exec?: ServiceExec
  env: NodeJS.ProcessEnv
}

export type ListMutagenSessionViewsResult = {
  available: boolean
  sessions: MutagenSessionView[]
  detail?: string
}

const execDefault: ServiceExec = async (command, args, options) => {
  const { commandExecFileAsync } = await import('../shared/exec')
  try {
    const result = await commandExecFileAsync(command, [...args], { env: options?.env, timeout: options?.timeoutMs })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }
    return {
      exitCode: typeof value.code === 'number' ? value.code : 1,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : typeof value.message === 'string' ? value.message : ''
    }
  }
}

export async function listMutagenSessionViews(options: ListMutagenSessionViewsOptions): Promise<ListMutagenSessionViewsResult> {
  const exec = options.exec ?? execDefault
  const home = options.env.HOME ?? process.env.HOME
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    ...(home === undefined ? {} : { HOME: home }),
    ...(options.env.TMPDIR === undefined ? {} : { TMPDIR: options.env.TMPDIR }),
    MUTAGEN_DATA_DIRECTORY: options.dataDirectory,
    MUTAGEN_DISABLE_AUTOSTART: '1'
  }
  const args = ['sync', 'list', '--template', '{{json .}}']
  if (options.profileId) {args.push(`--label-selector=${DEVBOX_SYNC_PROFILE_LABEL}=${options.profileId}`)}
  const result = await exec(options.binaryPath, args, { env })
  if (result.exitCode !== 0) {
    return { available: false, sessions: [], detail: result.stderr.trim() || `Mutagen exited with status ${result.exitCode}.` }
  }
  try {
    return { available: true, sessions: parseMutagenSessionViews(result.stdout, { profileId: options.profileId, hub: options.hub }) }
  } catch (error) {
    return { available: false, sessions: [], detail: error instanceof Error ? error.message : String(error) }
  }
}

export function parseMutagenSessionViews(json: string, filter: SessionFilter = {}): MutagenSessionView[] {
  const parsed = parseJson(json)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.flatMap((entry) => toView(entry, filter))
}

function parseJson(value: string): unknown {
  const text = value.trim()
  if (!text) {return []}
  try { return JSON.parse(text) as unknown } catch {
    const rows = text.split(/\r?\n/u).filter(Boolean)
    return rows.map((row) => JSON.parse(row) as unknown)
  }
}

function toView(value: unknown, filter: SessionFilter): MutagenSessionView[] {
  if (!isRecord(value)) {return []}
  const labels = asLabels(value.labels)
  const profileId = labels[DEVBOX_SYNC_PROFILE_LABEL] ?? null
  if (labels[DEVBOX_SYNC_BACKEND_LABEL] !== 'mutagen' || profileId === null || (filter.profileId && profileId !== filter.profileId)) {return []}
  const alpha = endpoint(value.alpha)
  const beta = endpoint(value.beta)
  const topology = topologyOf(alpha, beta, filter.hub, labels[DEVBOX_SYNC_ROOT_CLASS_LABEL])
  const problems = [problemArray(value.alpha, 'scanProblems'), problemArray(value.alpha, 'transitionProblems'), problemArray(value.beta, 'scanProblems'), problemArray(value.beta, 'transitionProblems')]
  const conflicts = Array.isArray(value.conflicts) ? value.conflicts : []
  return [{
    identifier: text(value.identifier) ?? '',
    name: text(value.name),
    labels,
    profileId,
    rootClass: labels[DEVBOX_SYNC_ROOT_CLASS_LABEL] ?? null,
    status: text(value.status) ?? 'unknown',
    paused: value.paused === true,
    successfulCycles: number(value.successfulCycles),
    conflictCount: conflicts.length,
    problemCount: problems.reduce((total, current) => total + current, 0),
    lastError: text(value.lastError),
    alpha,
    beta,
    topology: topology.kind,
    ...(topology.detail ? { topologyDetail: topology.detail } : {})
  }]
}

function endpoint(value: unknown): MutagenSessionEndpoint {
  const input = isRecord(value) ? value : {}
  return { protocol: text(input.protocol) ?? 'unknown', host: text(input.host), user: text(input.user), port: numberOrNull(input.port), path: text(input.path), connected: typeof input.connected === 'boolean' ? input.connected : null }
}

function topologyOf(alpha: MutagenSessionEndpoint, beta: MutagenSessionEndpoint, hub?: SessionFilter['hub'], rootClass?: string): { kind: MutagenSessionView['topology']; detail?: string } {
  if (alpha.protocol !== 'local') {return { kind: 'violation', detail: `alpha protocol is ${alpha.protocol}, expected local` }}
  if (beta.protocol === 'local') {return { kind: 'violation', detail: 'both endpoints local: local ↔ local is never allowed' }}
  if (beta.protocol !== 'ssh') {return { kind: 'violation', detail: `beta protocol is ${beta.protocol}, expected ssh` }}
  if (!hub) {return { kind: 'spoke-to-hub' }}
  const mismatches: string[] = []
  const auxiliary = rootClass === 'paste' || rootClass === 'credentials'
  if (!auxiliary && alpha.path !== hub.localRoot) {mismatches.push(`local root ${alpha.path ?? 'unknown'} != ${hub.localRoot}`)}
  if (beta.host !== hub.host) {mismatches.push(`hub host ${beta.host ?? 'unknown'} != ${hub.host}`)}
  if (beta.user !== hub.user) {mismatches.push(`hub user ${beta.user ?? 'unknown'} != ${hub.user}`)}
  if (!auxiliary && beta.path !== hub.remoteRoot) {mismatches.push(`hub root ${beta.path ?? 'unknown'} != ${hub.remoteRoot}`)}
  if (auxiliary) {
    // Paste/credential sessions mirror their own configured roots, not the profile's root pair.
    const configured = (hub.auxiliaryRoots ?? []).filter((root) => root.rootClass === rootClass)
    if (!configured.some((root) => samePath(alpha.path, root.localRoot) && samePath(beta.path, root.remoteRoot))) {
      mismatches.push(`${rootClass ?? 'auxiliary'} roots ${alpha.path ?? 'unknown'} -> ${beta.path ?? 'unknown'} match no configured ${rootClass ?? 'auxiliary'} root`)
    }
  }
  return mismatches.length === 0
    ? { kind: 'spoke-to-hub' }
    : { kind: 'violation', detail: `session does not point at the configured hub: ${mismatches.join('; ')}` }
}

function samePath(actual: string | null, expected: string): boolean {
  const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, '') : path)
  return actual !== null && trim(actual) === trim(expected)
}

function problemArray(value: unknown, key: string): number {
  return isRecord(value) && Array.isArray(value[key]) ? value[key].length : 0
}

function asLabels(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {return {}}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function text(value: unknown): string | null { return typeof value === 'string' ? value : null }
function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}
function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
