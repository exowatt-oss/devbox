import type { DevboxProfileV1 } from '../../shared/devbox-types'

/**
 * Synthetic `db sync` fixtures shaped like `mutagen sync list --template '{{json .}}'`
 * output on a local machine (Mutagen 0.18.1): workstation (project + roam workspace, credentials,
 * paste), macmini (running, not paused), and an optional proxy-powered host (devbox + label-only phi-sessions).
 */
export const HOME = '/Users/exampleuser'
export const PASTE_ROOT = '/tmp/devbox-paste'

type SessionInput = {
  id: string
  profile: string
  rootClass?: string
  local: string
  user: string
  host: string
  remote: string
  paused?: boolean
  status?: string
  port?: number
}

const endpointConfig = { ignore: {}, symlink: {}, watch: {}, permissions: {}, compression: {} }

export function sessionJson(input: SessionInput): Record<string, unknown> {
  const paused = input.paused ?? true
  const status = input.status ?? 'disconnected'
  const connected = !paused && status !== 'disconnected' && !status.startsWith('connecting')
  const labels: Record<string, string> = { 'devbox-backend': 'mutagen', 'devbox-profile': input.profile }
  if (input.rootClass !== undefined) {
    labels['devbox-root-class'] = input.rootClass
    labels['devbox-session'] = `${input.profile}-${input.rootClass}`
  }
  return {
    identifier: input.id,
    version: 1,
    creationTime: '2026-09-23T18:13:17.524097Z',
    creatingVersion: '0.18.1',
    alpha: { protocol: 'local', path: input.local, ...endpointConfig, connected, ...(connected ? { scanned: false } : {}) },
    beta: { protocol: 'ssh', user: input.user, host: input.host, ...(input.port === undefined ? {} : { port: input.port }), path: input.remote, ...endpointConfig, connected, ...(connected ? { scanned: false } : {}) },
    mode: 'two-way-safe',
    maxEntryCount: 2_000_000,
    stageMode: 'neighboring',
    ...endpointConfig,
    name: input.rootClass === undefined ? `devbox-${input.profile}` : `devbox-${input.rootClass}-${input.profile}-${input.rootClass}`,
    labels,
    paused,
    status
  }
}

const WORKSTATION = { user: 'sample', host: '203.0.113.10' }
const MACMINI = { user: 'exampleuser', host: '192.0.2.12' }
const AWS = { user: 'alice', host: 'devbox' }

export const REAL_SESSIONS: Record<string, unknown>[] = [
  sessionJson({ id: 'sync_project_decl', profile: 'project', rootClass: 'portable-declarative', local: `${HOME}/project`, ...WORKSTATION, remote: '/home/sample/project' }),
  sessionJson({ id: 'sync_project_work', profile: 'project', rootClass: 'portable-working', local: `${HOME}/project`, ...WORKSTATION, remote: '/home/sample/project' }),
  sessionJson({ id: 'sync_roam_decl', profile: 'roam', rootClass: 'portable-declarative', local: `${HOME}/scratch/roam`, ...WORKSTATION, remote: '/home/sample/roam' }),
  sessionJson({ id: 'sync_roam_work', profile: 'roam', rootClass: 'portable-working', local: `${HOME}/scratch/roam`, ...WORKSTATION, remote: '/home/sample/roam' }),
  sessionJson({ id: 'sync_roam_creds', profile: 'roam', rootClass: 'credentials', local: `${HOME}/.mcp-auth`, ...WORKSTATION, remote: '/home/sample/.mcp-auth' }),
  sessionJson({ id: 'sync_roam_paste', profile: 'roam', rootClass: 'paste', local: PASTE_ROOT, ...WORKSTATION, remote: PASTE_ROOT }),
  sessionJson({ id: 'sync_macmini_decl', profile: 'macmini', rootClass: 'portable-declarative', local: `${HOME}/project`, ...MACMINI, remote: '/Users/exampleuser/project', paused: false, status: 'scanning' }),
  sessionJson({ id: 'sync_macmini_work', profile: 'macmini', rootClass: 'portable-working', local: `${HOME}/project`, ...MACMINI, remote: '/Users/exampleuser/project', paused: false, status: 'scanning' }),
  sessionJson({ id: 'sync_devbox_decl', profile: 'devbox', rootClass: 'portable-declarative', local: `${HOME}/project`, ...AWS, remote: '/home/alice/project' }),
  sessionJson({ id: 'sync_devbox_work', profile: 'devbox', rootClass: 'portable-working', local: `${HOME}/project`, ...AWS, remote: '/home/alice/project' }),
  sessionJson({ id: 'sync_phi', profile: 'phi-sessions', local: `${HOME}/.pi/agent/session-sync`, ...AWS, remote: '/home/alice/.pi/agent/session-sync' })
]

export const DEVBOXES_CLI = `${HOME}/.local/bin/devbox`

export function fixtureProfile(id: string, identity: { user: string; host: string; port?: number }, extra: { device?: string; proxyCommand?: string } = {}): DevboxProfileV1 {
  return {
    schemaVersion: 3,
    id,
    displayName: id,
    ...(extra.device === undefined ? {} : { device: extra.device }),
    sshTarget: {
      targetId: `devbox-${id}`,
      identity: { host: identity.host, port: identity.port ?? 22, username: identity.user, hostKeyFingerprint: 'SHA256:abc' },
      ...(extra.proxyCommand === undefined ? {} : { proxyCommand: extra.proxyCommand })
    },
    roots: { localRoot: `${HOME}/project`, remoteRoot: `/home/${identity.user}/project` },
    pathMap: [],
    toolchain: { lockId: 'toolchain', lockSha256: 'a'.repeat(64) },
    sync: { classes: [{ id: 'working', kind: 'portable-working', backend: 'mutagen', mode: 'two-way-safe', excludes: [] }], defaultClassId: 'working', excludes: [] },
    credentials: [],
    defaultAuthority: 'local',
    projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
    featureDefaults: { detachedJobs: true, closedSessionHistory: true },
    slo: { syncLagTargetMs: 1, reconnectTargetMs: 1, operationRecoveryTargetMs: 1, offlineEdits: 'warn' }
  }
}

export const PROFILES: DevboxProfileV1[] = [
  fixtureProfile('project', WORKSTATION, { device: 'workstation' }),
  fixtureProfile('roam', WORKSTATION),
  fixtureProfile('macmini', MACMINI, { device: 'macmini' }),
  fixtureProfile('devbox', AWS, { device: 'aws', proxyCommand: `${DEVBOXES_CLI} proxy` })
]

export const MACHINE_KEYS = {
  workstation: 'sample@203.0.113.10:22',
  macmini: 'exampleuser@192.0.2.12:22',
  aws: 'alice@devbox:22'
} as const
