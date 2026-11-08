import type { DevboxShellSession } from './shell-sessions'
import {
  buildDevboxShellAttachCommandLine,
  createForcaTerminal,
  findForcaCli,
  listForcaDevboxTerminals,
  probeForcaRuntime,
  resolveDevboxSelfCommand,
  resolveForcaWorktreeSelector,
  runForcaCommand,
  type ForcaCommandRunner
} from './forca-terminals'

/** One profile's sessions, as listed on the device that owns the profile. */
export type DevboxShellReconnectAllTarget = {
  profileId: string
  device: string
  sessions: readonly DevboxShellSession[]
}

/** A device the all-devices listing could not reach (or skipped from its unreachable memory). */
export type DevboxShellReconnectAllSkippedDevice = {
  device: string
  status: 'unreachable' | 'skipped'
  error: string
}

export type DevboxShellReconnectAllPlanRow = {
  id: number
  name?: string
  sessionName: string
  profileId: string
  device: string
  /** Forca tab title: the friendly name, `#<id>` when unnamed, `@<device>` when it collides across devices. */
  title: string
  action: 'here' | 'forca' | 'skip-attached'
  command: string
}

type ReconnectAllResultRow = DevboxShellReconnectAllPlanRow & {
  /** `already-open`: a Forca terminal is already attached to it (its handle is reported, no new tab). */
  status: 'planned' | 'launched' | 'failed' | 'already-open'
  handle?: string
  error?: string
}

export type DevboxShellReconnectAllResult = {
  /** Set for single-profile runs (explicit --profile/--device). */
  profileId?: string
  /** Set for runs that covered every configured device, like `shell ls`. */
  scope?: 'all-devices'
  skippedDevices?: DevboxShellReconnectAllSkippedDevice[]
  worktreeSelector?: string
  dryRun: boolean
  rows: ReconnectAllResultRow[]
  here?: { id: number; sessionName: string; profileId: string }
}

export type DevboxShellReconnectAllHere = { profileId: string; sessionName: string }

type ReconnectAllInput = {
  /** Single-profile runs only; an all-devices run leaves it undefined. */
  profileId?: string
  targets: readonly DevboxShellReconnectAllTarget[]
  skippedDevices?: readonly DevboxShellReconnectAllSkippedDevice[]
  here?: DevboxShellReconnectAllHere
  cwd: string
  dryRun: boolean
  worktreeOverride?: string
  env: NodeJS.ProcessEnv
  run?: ForcaCommandRunner
  forcaBinary?: string
  devboxCommand?: string
}

export function planDevboxShellReconnectAll(
  targets: readonly DevboxShellReconnectAllTarget[],
  here: DevboxShellReconnectAllHere | undefined,
  devboxCommand: string
): DevboxShellReconnectAllPlanRow[] {
  const rows = targets.flatMap((target) => [...target.sessions]
    .sort((left, right) => left.id - right.id || left.sessionName.localeCompare(right.sessionName))
    .map((session) => ({
      id: session.id,
      ...(session.name === undefined ? {} : { name: session.name }),
      sessionName: session.sessionName,
      profileId: target.profileId,
      device: target.device,
      title: baseTitle(session),
      action: session.attached
        ? 'skip-attached' as const
        : here?.profileId === target.profileId && here.sessionName === session.sessionName ? 'here' as const : 'forca' as const,
      command: buildDevboxShellAttachCommandLine(devboxCommand, target.profileId, session.sessionName)
    })))
  return disambiguateTitles(rows)
}

function baseTitle(session: DevboxShellSession): string {
  return session.name ?? `#${session.id}`
}

/** A title shared by sessions on different devices gets an `@<device>` suffix. */
function disambiguateTitles(rows: DevboxShellReconnectAllPlanRow[]): DevboxShellReconnectAllPlanRow[] {
  const devicesByTitle = new Map<string, Set<string>>()
  for (const row of rows) {
    const devices = devicesByTitle.get(row.title) ?? new Set<string>()
    devices.add(row.device)
    devicesByTitle.set(row.title, devices)
  }
  return rows.map((row) => (devicesByTitle.get(row.title)?.size ?? 0) > 1
    ? { ...row, title: `${row.title}@${row.device}` }
    : row)
}

export async function runDevboxShellReconnectAll(
  input: ReconnectAllInput
): Promise<DevboxShellReconnectAllResult> {
  const devboxCommand = input.devboxCommand ?? resolveDevboxSelfCommand()
  const plan = planDevboxShellReconnectAll(input.targets, input.here, devboxCommand)
  const rows: ReconnectAllResultRow[] = plan.map((row) => ({ ...row, status: 'planned' }))
  const hereRow = rows.find((row) => row.action === 'here')
  const base: DevboxShellReconnectAllResult = {
    ...(input.profileId === undefined ? { scope: 'all-devices' as const } : { profileId: input.profileId }),
    ...(input.skippedDevices === undefined || input.skippedDevices.length === 0 ? {} : { skippedDevices: [...input.skippedDevices] }),
    dryRun: input.dryRun,
    rows,
    ...(hereRow === undefined ? {} : { here: { id: hereRow.id, sessionName: hereRow.sessionName, profileId: hereRow.profileId } })
  }
  const forcaRows = rows.filter((row) => row.action === 'forca')
  if (forcaRows.length === 0) {return base}

  const binary = input.forcaBinary ?? findForcaCli(input.env)
  if (input.dryRun) {return base}
  const manual = manualReconnectCommands(rows)
  if (binary === undefined || binary.length === 0) {
    throw new Error(`Forca CLI (forca) not found on PATH. Reconnect manually:\n${manual}`)
  }

  const run = input.run ?? runForcaCommand
  const runtime = await probeForcaRuntime(run, binary)
  if (!runtime.ok) {
    throw new Error(`Forca runtime is not reachable (${runtime.reason}). Reconnect manually:\n${manual}`)
  }

  base.worktreeSelector = await resolveForcaWorktreeSelector(run, binary, input.cwd, input.worktreeOverride)
  // A tab mid-reconnect has no tmux client, so `attached` misses it; Forca knows the tab is there.
  const open = await listForcaDevboxTerminals(run, binary, input.cwd)
  for (const row of forcaRows) {
    const existing = open.find((terminal) => terminal.profileId === row.profileId && terminal.sessionName === row.sessionName)
    if (existing !== undefined) {
      row.status = 'already-open'
      if (existing.handle !== undefined) {row.handle = existing.handle}
      continue
    }
    await launchRow(run, binary, base.worktreeSelector, input.cwd, row)
  }
  return base
}

async function launchRow(
  run: ForcaCommandRunner,
  binary: string,
  worktreeSelector: string,
  cwd: string,
  row: ReconnectAllResultRow
): Promise<void> {
  try {
    const created = await createForcaTerminal(run, binary, { worktreeSelector, command: row.command, title: row.title, cwd })
    if (created.ok) {
      row.status = 'launched'
      if (created.handle !== undefined) {row.handle = created.handle}
    } else {
      row.status = 'failed'
      row.error = created.reason
    }
  } catch (error) {
    row.status = 'failed'
    row.error = error instanceof Error ? error.message : String(error)
  }
}

function manualReconnectCommands(
  rows: readonly ReconnectAllResultRow[]
): string {
  return rows
    .filter((row) => row.action !== 'skip-attached')
    .map((row) => `  ${row.command}`)
    .join('\n')
}
