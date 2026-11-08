import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { DevboxShellAttachHistory } from './shell-attach-history'
import { createDevboxShellAttachHistory, readDevboxTtyPath, resolveDevboxTerminalKey } from './shell-attach-history'
import { resolveDevboxSelfCommand } from './forca-terminals'
import { listDevboxShellSessions } from './shell'
import type { DevboxShellDevicesListResult } from './shell-devices'
import {
  runDevboxShellReconnectAll,
  type DevboxShellReconnectAllHere,
  type DevboxShellReconnectAllResult,
  type DevboxShellReconnectAllSkippedDevice,
  type DevboxShellReconnectAllTarget
} from './shell-reconnect-all'

export function createDevboxServiceShellHistory(
  stateRoot: string,
  env: NodeJS.ProcessEnv
): DevboxShellAttachHistory {
  return createDevboxShellAttachHistory({
    stateRoot,
    env,
    terminalKey: resolveDevboxTerminalKey(env, readDevboxTtyPath)
  })
}

type ServiceReconnectAllInput = {
  history: DevboxShellAttachHistory
  cwd: string
  dryRun: boolean
  worktreeOverride?: string
  allowHere: boolean
  env: NodeJS.ProcessEnv
}

/** Explicit --profile/--device: one profile's sessions, as before. */
export async function runDevboxServiceShellReconnectAll(input: ServiceReconnectAllInput & {
  profileId: string
  device: string
  runner: DevboxSshRunner
}): Promise<DevboxShellReconnectAllResult> {
  const sessions = await listDevboxShellSessions(input.profileId, input.runner)
  const target = { profileId: input.profileId, device: input.device, sessions: sessions.sessions }
  return reconnect(input, [target], [], input.profileId)
}

/** No explicit selection: every device `shell ls` lists, reusing its listing (budgets, unreachable memory). */
export async function runDevboxServiceShellReconnectEverywhere(input: ServiceReconnectAllInput & {
  listAll: () => Promise<DevboxShellDevicesListResult>
}): Promise<DevboxShellReconnectAllResult> {
  const listed = await input.listAll()
  const targets: DevboxShellReconnectAllTarget[] = []
  const skipped: DevboxShellReconnectAllSkippedDevice[] = []
  for (const device of listed.devices) {
    if (device.status !== 'ok') {
      skipped.push({ device: device.device, status: device.status, error: device.error ?? device.status })
      continue
    }
    for (const profile of device.profiles) {
      if (profile.reachable) {targets.push({ profileId: profile.profileId, device: device.device, sessions: profile.sessions })}
    }
  }
  return reconnect(input, targets, skipped, undefined)
}

async function reconnect(
  input: ServiceReconnectAllInput,
  targets: readonly DevboxShellReconnectAllTarget[],
  skippedDevices: readonly DevboxShellReconnectAllSkippedDevice[],
  profileId: string | undefined
): Promise<DevboxShellReconnectAllResult> {
  const here = input.allowHere ? await lastForThisTerminal(input.history, targets) : undefined
  return runDevboxShellReconnectAll({
    ...(profileId === undefined ? {} : { profileId }),
    targets,
    skippedDevices,
    ...(here === undefined ? {} : { here }),
    cwd: input.cwd,
    dryRun: input.dryRun,
    worktreeOverride: input.worktreeOverride,
    env: input.env,
    devboxCommand: resolveDevboxSelfCommand()
  })
}

/** This terminal's most recent attach across the listed profiles, on its own profile. */
async function lastForThisTerminal(
  history: DevboxShellAttachHistory,
  targets: readonly DevboxShellReconnectAllTarget[]
): Promise<DevboxShellReconnectAllHere | undefined> {
  const records = await Promise.all(targets.map((target) => history.lastForTerminal(target.profileId)))
  const latest = records.reduce((best, record) =>
    record !== undefined && (best === undefined || record.attachedAt > best.attachedAt) ? record : best, undefined as (typeof records)[number])
  return latest === undefined ? undefined : { profileId: latest.profileId, sessionName: latest.sessionName }
}
