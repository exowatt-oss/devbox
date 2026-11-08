/**
 * Shared contract for the hub-and-spoke Mutagen surface:
 *
 *   devbox mutagen <status|setup|start|stop|restart|delete|logs|flush|pause|resume|spokes>
 *   devbox init      this machine's local root seeds a NEW hub on the remote host
 *   devbox connect   this machine joins an EXISTING hub as one more spoke
 *
 * Topology invariant (enforced, never inferred):
 *   - A workspace has exactly one HUB: the remote Linux host + remote root. It is the
 *     source of truth. The hub runs no Mutagen daemon; it only hosts the
 *     `mutagen-agent` processes that each spoke's daemon spawns over SSH.
 *   - A workspace has N SPOKES: local machines (macOS or Linux) each running their own
 *     app-private Mutagen daemon. Every Devbox-owned session on a spoke has
 *     alpha = local root (protocol `local`) and beta = ssh://<hub user>@<hub host>/<hub root>.
 *   - Spokes NEVER synchronize with each other, and a spoke root is never used as
 *     another machine's hub (no chaining). `devbox connect` refuses a hub that resolves to
 *     the local machine, and `devbox mutagen status` reports any session that breaks the
 *     spoke-to-hub shape as a topology violation.
 *
 * Every worker module imports its types from here; keep this file types-and-constants only.
 */

/** launchd label (macOS) and systemd --user unit name (Linux) of the keepalive service. */
export const MUTAGEN_SERVICE_LAUNCHD_LABEL = 'org.devbox.mutagen-daemon' as const
export const MUTAGEN_SERVICE_SYSTEMD_UNIT = 'devbox-mutagen-daemon.service' as const
/** Relative to the local Devbox state root (`${DEVBOX_STATE_ROOT:-~/.local/state/devbox}`). */
export const MUTAGEN_SERVICE_WRAPPER_RELATIVE = 'bin/devbox-mutagen-daemon' as const
export const MUTAGEN_SERVICE_LOG_RELATIVE = 'logs/mutagen-daemon.log' as const
export const SPOKE_IDENTITY_RELATIVE = 'spoke.json' as const
export const SPOKE_ROOTS_RELATIVE = 'spoke-roots.json' as const
/** Relative to the REMOTE user's `$HOME`; hub records live at `<this>/<hubId>/hub.json`, spokes at `<this>/<hubId>/spokes/<spokeId>.json`. */
export const HUB_REGISTRY_RELATIVE = '.local/state/devbox/hub' as const

export type HubPlatform = 'darwin' | 'linux' | 'unsupported'
export type MutagenServiceManager = 'launchd' | 'systemd-user' | 'none'

export type MutagenDaemonServiceState = {
  platform: HubPlatform
  manager: MutagenServiceManager
  /** launchd label or systemd unit name; '' when unsupported. */
  label: string
  /** Absolute plist / unit-file path; '' when unsupported. */
  unitPath: string
  wrapperPath: string
  logPath: string
  /** The unit file exists on disk. */
  installed: boolean
  /** launchd knows the label (bootstrap succeeded) / systemd unit is enabled. */
  loaded: boolean
  /** The service manager reports the wrapper as running. */
  running: boolean
  /** Wrapper (supervisor) pid as reported by the manager. */
  pid: number | null
  detail?: string
}

export type MutagenDaemonProbe = {
  running: boolean
  pid: number | null
  /** 'service' = child of the managed wrapper; 'on-demand' = started by a devbox command; 'unknown' = process ownership or probing is unavailable; 'none' when the probe confirms no matching daemon. */
  origin: 'service' | 'on-demand' | 'unknown' | 'none'
  binaryPath: string | null
  version: string | null
  dataDirectory: string
  /** Newest mtime (epoch ms) under `<dataDirectory>/archives`, i.e. the last completed cycle; null when unknown. */
  lastCycleAt: number | null
}

export type MutagenSessionEndpoint = {
  protocol: string
  host: string | null
  user: string | null
  port: number | null
  path: string | null
  connected: boolean | null
}

export type MutagenSessionTopology = 'spoke-to-hub' | 'violation'

export type MutagenSessionView = {
  identifier: string
  name: string | null
  labels: Readonly<Record<string, string>>
  profileId: string | null
  rootClass: string | null
  status: string
  paused: boolean
  successfulCycles: number
  conflictCount: number
  problemCount: number
  lastError: string | null
  alpha: MutagenSessionEndpoint
  beta: MutagenSessionEndpoint
  topology: MutagenSessionTopology
  topologyDetail?: string
}

export type HubRecord = {
  hubId: string
  root: string
  host: string
  user: string
  createdAt: string
  createdBy: { spokeId: string; hostname: string }
  devboxVersion: string
}

export type SpokeRecord = {
  spokeId: string
  hostname: string
  platform: string
  username: string
  localRoot: string
  profileId: string
  devboxVersion: string
  registeredAt: string
  lastSeenAt: string
}

export type HubView = {
  reachable: boolean
  hubId: string
  root: string
  host: string
  port: number
  user: string
  /** `hub.json` exists on the remote for this root. */
  registered: boolean
  record: HubRecord | null
  spokes: readonly SpokeRecord[]
  thisSpokeId: string
  /** Live `mutagen-agent synchronizer` processes on the hub (all roots; best effort), null when unknown. */
  liveAgentCount: number | null
  detail?: string
}

export type MutagenTopologyVerdict = 'ok' | 'violation' | 'no-sessions'

export type MutagenStatusResult = {
  profileId: string | null
  binary: { path: string | null; version: string | null; dataDirectory: string }
  service: MutagenDaemonServiceState
  daemon: MutagenDaemonProbe
  sessions: readonly MutagenSessionView[]
  topology: { verdict: MutagenTopologyVerdict; violations: readonly string[] }
  /** null when no profile is selected or `--no-remote` was passed. */
  hub: HubView | null
  hints: readonly string[]
}

export type MutagenSetupServiceAction = 'installed' | 'updated' | 'unchanged' | 'skipped' | 'unsupported'

export type MutagenSetupResult = {
  profileId: string | null
  service: MutagenDaemonServiceState & { action: MutagenSetupServiceAction }
  daemon: MutagenDaemonProbe
  hub: HubView | null
  /** A pre-0.3.0 hand-rolled wrapper (for example `~/.local/bin/devbox-mutagen-daemon`) that is now unused. */
  legacyWrapper: string | null
  hints: readonly string[]
}

export type MutagenServiceAction = 'start' | 'stop' | 'restart' | 'delete'

export type MutagenServiceActionResult = {
  action: MutagenServiceAction
  via: MutagenServiceManager | 'mutagen-cli'
  service: MutagenDaemonServiceState
  daemon: MutagenDaemonProbe
  detail?: string
}

export type MutagenLogsResult = {
  logPath: string
  exists: boolean
  lines: readonly string[]
}

/** `flush`/`resume` are one-shot `db sync --profile` runs now; only pause acts on sessions directly. */
export type MutagenSessionAction = 'pause'

export type MutagenSessionActionResult = {
  profileId: string
  action: MutagenSessionAction
  sessions: readonly { identifier: string; name: string | null; ok: boolean; error?: string }[]
}

export type MutagenSpokesResult = {
  profileId: string
  hub: HubView
}

export type BootstrapStepStatus = 'ok' | 'skipped' | 'warning' | 'failed'

export type BootstrapStep = {
  /** Stable machine id, e.g. `local-root`, `host-key`, `profile`, `remote`, `preflight`, `default-profile`, `env-file`, `shell-dir`, `service`, `pair`, `hub-registry`. */
  id: string
  status: BootstrapStepStatus
  detail: string
  durationMs?: number
}

export type BootstrapProgress = (step: BootstrapStep) => void

export type WorkspaceBootstrapResult = {
  mode: 'init' | 'connect'
  profileId: string
  host: string
  port: number
  user: string
  localRoot: string
  remoteRoot: string
  fingerprint: string | null
  steps: readonly BootstrapStep[]
  /** ready = paired and syncing; blocked = profile saved but preflight/pair did not complete; failed = stopped before the profile was usable. */
  status: 'ready' | 'blocked' | 'failed'
  /** The `pair` result when pairing ran, else null. */
  pair: unknown
  mutagen: MutagenSetupResult | null
  nextSteps: readonly string[]
}

type WorkspaceBootstrapCommon = {
  host: string
  port: number
  user: string
  profileId?: string
  fingerprint?: string
  /** Optional OpenSSH ProxyCommand pinned into the profile (e.g. `$HOME/.local/bin/devbox proxy`). */
  proxyCommand?: string
  /** Accept the first scanned host key when no --fingerprint is given. */
  yes: boolean
  /** Overwrite an existing profile with the same id. */
  force: boolean
  envFile?: string
  shellDir?: string
  /** Install/refresh the local keepalive service (default true; `--no-service` disables). */
  service: boolean
  /** Pair after the profile is ready (default true; `--no-pair` disables). */
  pair: boolean
}

export type InitWorkspaceInput = WorkspaceBootstrapCommon & {
  localRoot: string
  /** Defaults to `<remote $HOME>/<basename(localRoot)>`. */
  remoteRoot?: string
  /** Pair even when the remote root already has content (two-way-safe: differing files become conflicts, never deletions). */
  adoptRemote: boolean
}

export type ConnectWorkspaceInput = WorkspaceBootstrapCommon & {
  remoteRoot: string
  /** Defaults to `<local home>/<basename(remoteRoot)>`. */
  localRoot?: string
  /** Join even when the local root already has content. */
  allowNonEmptyLocal: boolean
}

/**
 * Service surface consumed by the `mutagen`, `init`, and `connect` handlers. Every member is
 * optional so existing test fixtures keep compiling; handlers throw a CliArgumentError when a
 * member is missing.
 */
export type DevboxHubServiceLike = {
  mutagenStatus?(profileId: string | undefined, options: { remote: boolean }): Promise<MutagenStatusResult>
  mutagenSetup?(profileId: string | undefined, options: { remote: boolean; service: boolean }): Promise<MutagenSetupResult>
  mutagenServiceAction?(action: MutagenServiceAction): Promise<MutagenServiceActionResult>
  mutagenLogs?(lines: number): Promise<MutagenLogsResult>
  mutagenSessionAction?(profileId: string, action: MutagenSessionAction): Promise<MutagenSessionActionResult>
  mutagenSpokes?(profileId: string): Promise<MutagenSpokesResult>
  initWorkspace?(input: InitWorkspaceInput, progress?: BootstrapProgress): Promise<WorkspaceBootstrapResult>
  connectWorkspace?(input: ConnectWorkspaceInput, progress?: BootstrapProgress): Promise<WorkspaceBootstrapResult>
}
