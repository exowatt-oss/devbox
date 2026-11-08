/**
 * Contract for `db sync` ("sync now"): flush every Devbox-owned Mutagen session to every
 * machine in parallel, skip machines that are unreachable or hang, and report live progress.
 *
 * The engine (sync-now.ts and friends) emits SyncNowEvent values; renderers (live TUI,
 * plain line log, JSON) consume them. Neither side imports the other.
 */

import type { Presentation } from './presentation-types'

/** What a lane carries, derived from Mutagen labels (devbox-root-class / devbox-profile). */
export type SyncLaneKind = 'workspace' | 'images' | 'credentials' | 'phi-sessions' | 'other'

/** One logical sync on one machine: every Mutagen session sharing a profile + local/remote root pair. */
export type SyncLane = {
  /** Stable key, unique within the plan, e.g. `devbox:workspace`. */
  key: string
  kind: SyncLaneKind
  /** Short human label: `workspace`, `images`, `credentials`, `phi sessions`, or the profile id. */
  label: string
  /** Value of the devbox-profile label (may have no profile JSON, e.g. `phi-sessions`). */
  profileId: string
  /** Local root with $HOME shown as `~`. */
  localPath: string
  remotePath: string
  /** Mutagen session identifiers in this lane (older pairs also have a portable-declarative twin on the same roots). */
  sessionIds: string[]
  /** Session ids that were paused before the run (the ones it resumes). Every session is paused when the run ends. */
  pausedBefore: string[]
}

/** One machine = one ssh endpoint (user@host:port). Profiles sharing an endpoint share a machine. */
export type SyncMachine = {
  key: string
  /** Device alias (`devbox`, `macmini`, `workstation`), else the host. */
  name: string
  user: string
  host: string
  port: number
  /** True when ssh goes through a ProxyCommand (e.g. `devbox proxy` for host with a configured power provideres). */
  proxied: boolean
  lanes: SyncLane[]
}

export type SyncNowPlan = {
  machines: SyncMachine[]
  /** Epoch ms when the run started (after the lock was taken). */
  startedAt: number
  /** Per-machine hard cap in ms (`--timeout`). */
  timeoutMs: number
}

/** User-facing phase of a machine or lane. Terminal phases: synced, skipped, failed. */
export type SyncPhase =
  | 'queued'
  | 'checking'      // reachability probe
  | 'waking'        // --wake: asking a stopped host with a configured power provider to start
  | 'preparing'     // `before` sync hooks
  | 'connecting'    // Mutagen connecting-alpha / connecting-beta / disconnected after resume
  | 'scanning'      // scanning / waiting-for-rescan
  | 'reconciling'
  | 'transferring'  // staging-alpha / staging-beta / transitioning
  | 'saving'
  | 'finishing'     // `after` sync hooks and re-pausing
  | 'synced'
  | 'skipped'
  | 'failed'

export type SyncSkipReason =
  | 'unreachable'   // probe failed (no route, refused, auth, no answer within budget)
  | 'stopped'       // host with a configured power provider is stopped and --wake was not given
  | 'stalled'       // endpoint disconnected/connecting longer than the stall grace mid-sync
  | 'timeout'       // exceeded the per-machine cap
  | 'interrupted'   // Ctrl-C / SIGTERM

/** Live progress of one lane, recomputed from `mutagen sync list` polls. */
export type SyncLaneProgress = {
  phase: SyncPhase
  /** Raw Mutagen status of the least-advanced session in the lane (e.g. `staging-beta`). */
  mutagenStatus?: string
  /** Staging progress while transferring (summed across the lane's sessions). */
  staging?: { receivedFiles: number; expectedFiles: number; receivedBytes: number; expectedBytes?: number; path?: string }
  /** File count on the local side once a scan finished. */
  files?: number
  conflicts: number
  problems: number
  lastError?: string
}

export type SyncMachineOutcome = {
  machineKey: string
  state: 'synced' | 'skipped' | 'failed'
  reason?: SyncSkipReason
  /** One-line human detail: `no answer in 5 s`, `stopped (db sync --wake starts it)`, Mutagen error text. */
  detail?: string
  elapsedMs: number
  conflicts: number
  problems: number
  /** Non-fatal hook failures and similar notes. */
  warnings: string[]
  lanes: { laneKey: string; state: 'synced' | 'skipped' | 'failed'; conflicts: number; problems: number; files?: number }[]
}

export type SyncNowResult = {
  ok: boolean
  startedAt: number
  elapsedMs: number
  machines: SyncMachineOutcome[]
  syncedCount: number
  skippedCount: number
  failedCount: number
  interrupted: boolean
}

export type SyncNowEvent =
  /** `holderCommand`: what holds the lock (`db sync`, `db mutagen restart`, ...). */
  | { type: 'lock-wait'; holderPid: number; holderStartedAt?: number; holderCommand?: string }
  | { type: 'plan'; plan: SyncNowPlan }
  | { type: 'machine-phase'; machineKey: string; phase: SyncPhase; detail?: string }
  | { type: 'lane-progress'; machineKey: string; laneKey: string; progress: SyncLaneProgress }
  | { type: 'machine-done'; outcome: SyncMachineOutcome }
  | { type: 'warning'; machineKey?: string; message: string }
  | { type: 'finished'; result: SyncNowResult }

export type SyncNowListener = (event: SyncNowEvent) => void

/** Renderer factory signature implemented by sync-now-render.ts and consumed by the `sync` handler. */
export type SyncNowRenderMode = 'live' | 'plain'

export type SyncNowRendererOptions = {
  mode: SyncNowRenderMode
  /** Final summary goes here (stays in scrollback). */
  stdout: { write(text: string): unknown }
  /** Live redraw region (live mode) or progress lines (plain mode). */
  /** `rows` (process.stderr.rows) keeps the live board inside the terminal height; default 24. */
  stderr: { write(text: string): unknown; columns?: number; rows?: number; isTTY?: boolean }
  /** From createPresentation(); carries color + width decisions. */
  presentation: Presentation
  /** Unicode glyphs/spinner allowed (unicodeEnabled(presentationOptions)). */
  glyphs: boolean
  now?: () => number
  /** Redraw cadence for live mode; default 100 ms. */
  intervalMs?: number
}

export type SyncNowRenderer = {
  onEvent: SyncNowListener
  /** Stop timers, restore the cursor, leave the terminal clean. Idempotent; safe on Ctrl-C. */
  close(): void
}
