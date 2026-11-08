import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MutagenDaemonServiceState, MutagenSetupServiceAction } from './hub-types'
import type { ServiceExec } from './mutagen-service'
import { renderLaunchdPlist, renderMutagenWrapperScript } from './mutagen-service-wrapper'

export type LaunchdServiceOptions = {
  label: string
  unitPath: string
  wrapperPath: string
  logPath: string
  home: string
  stateRoot: string
  devboxVersion: string
  env: NodeJS.ProcessEnv
  exec: ServiceExec
  uid: number
}

export function parseLaunchctlPrint(output: string): { state: string | null; pid: number | null } {
  const stateMatch = output.match(/^\s*state\s*=\s*([^\s]+)\s*$/m)
  const pidMatch = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m)
  const pid = pidMatch ? Number(pidMatch[1]) : null
  return {
    state: stateMatch?.[1] ?? null,
    pid: pid !== null && pid > 0 ? pid : null
  }
}

function stateBase(options: LaunchdServiceOptions): MutagenDaemonServiceState {
  return {
    platform: 'darwin',
    manager: 'launchd',
    label: options.label,
    unitPath: options.unitPath,
    wrapperPath: options.wrapperPath,
    logPath: options.logPath,
    installed: existsSync(options.unitPath),
    loaded: false,
    running: false,
    pid: null
  }
}

function withDetail(state: MutagenDaemonServiceState, detail: string): MutagenDaemonServiceState {
  const trimmed = detail.trim()
  return trimmed ? { ...state, detail: trimmed } : state
}

function commandDetail(result: { exitCode: number; stderr: string; stdout: string }): string {
  return result.stderr.trim() || result.stdout.trim() || `launchctl exited with code ${result.exitCode}`
}

async function launchctl(options: LaunchdServiceOptions, args: readonly string[]) {
  try {
    return await options.exec('launchctl', args, { env: options.env, timeoutMs: 10_000 })
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

function ensureDirectory(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode })
  chmodSync(path, mode)
}

function writeIfChanged(path: string, content: string, mode: number): { exists: boolean; changed: boolean } {
  const existed = existsSync(path)
  const changed = !existed || readFileSync(path, 'utf8') !== content
  if (changed) {
    writeFileSync(path, content, { mode })
  }
  chmodSync(path, mode)
  return { exists: existed, changed }
}

export function createLaunchdService(options: LaunchdServiceOptions) {
  const describe = async (): Promise<MutagenDaemonServiceState> => {
    const state = stateBase(options)
    const result = await launchctl(options, ['print', `gui/${options.uid}/${options.label}`])
    if (result.exitCode !== 0) {
      return withDetail(state, commandDetail(result))
    }
    const parsed = parseLaunchctlPrint(result.stdout)
    return { ...state, loaded: true, running: parsed.state === 'running', pid: parsed.pid }
  }

  const bootstrap = async (): Promise<string | null> => {
    const result = await launchctl(options, ['bootstrap', `gui/${options.uid}`, options.unitPath])
    if (result.exitCode === 0 || result.exitCode === 37 || /already/i.test(result.stderr)) {
      return null
    }
    return commandDetail(result)
  }

  const bootout = async (): Promise<string | null> => {
    const result = await launchctl(options, ['bootout', `gui/${options.uid}/${options.label}`])
    if (result.exitCode === 0 || result.exitCode === 3 || /no such process/i.test(result.stderr)) {
      return null
    }
    return commandDetail(result)
  }

  // Why: launchd tears a booted-out job down asynchronously (SIGTERM to the wrapper, which
  // waits for Mutagen to halt every session). A bootstrap inside that window can answer
  // 37 / "already" (or EIO) and leave the label unloaded — `db mutagen setup` after an
  // upgrade then left no service. Wait for the label to go, then bootstrap until loaded.
  const isLoaded = async (): Promise<boolean> =>
    (await launchctl(options, ['print', `gui/${options.uid}/${options.label}`])).exitCode === 0
  const settle = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  const waitUnloaded = async (): Promise<void> => {
    for (let attempt = 0; attempt < 40 && await isLoaded(); attempt += 1) {await settle(250)}
  }
  const bootstrapUntilLoaded = async (): Promise<string | null> => {
    let detail: string | null = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {await settle(1000)}
      detail = await bootstrap()
      if (await isLoaded()) {return null}
    }
    return detail ?? `launchctl bootstrap did not load ${options.label}`
  }

  const kickstart = async (kill: boolean): Promise<string | null> => {
    const args = kill
      ? ['kickstart', '-k', `gui/${options.uid}/${options.label}`]
      : ['kickstart', `gui/${options.uid}/${options.label}`]
    const result = await launchctl(options, args)
    return result.exitCode === 0 ? null : commandDetail(result)
  }

  const install = async (input: { binaryPath: string; dataDirectory: string }): Promise<{ state: MutagenDaemonServiceState; action: MutagenSetupServiceAction }> => {
    const before = await describe()
    const wrapper = renderMutagenWrapperScript({ ...input, devboxVersion: options.devboxVersion, home: options.home })
    const plist = renderLaunchdPlist({
      label: options.label,
      wrapperPath: options.wrapperPath,
      dataDirectory: input.dataDirectory,
      logPath: options.logPath,
      home: options.home
    })
    let wrapperFile: { exists: boolean; changed: boolean }
    let plistFile: { exists: boolean; changed: boolean }
    try {
      ensureDirectory(options.stateRoot, 0o700)
      ensureDirectory(dirname(options.wrapperPath), 0o700)
      ensureDirectory(dirname(options.logPath), 0o700)
      mkdirSync(dirname(options.unitPath), { recursive: true, mode: 0o700 })
      wrapperFile = writeIfChanged(options.wrapperPath, wrapper, 0o755)
      plistFile = writeIfChanged(options.unitPath, plist, 0o644)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { state: withDetail({ ...before, installed: existsSync(options.unitPath) }, detail), action: 'updated' }
    }
    const changed = wrapperFile.changed || plistFile.changed
    let detail: string | null = null
    if (!before.loaded) {
      detail = await bootstrapUntilLoaded()
    } else if (changed) {
      const bootoutDetail = await bootout()
      if (!bootoutDetail) {await waitUnloaded()}
      detail = bootoutDetail ?? await bootstrapUntilLoaded()
    } else if (!before.running) {
      detail = await kickstart(false)
    }
    const state = await describe()
    const existed = wrapperFile.exists || plistFile.exists
    return { state: detail ? withDetail(state, detail) : state, action: !existed ? 'installed' : changed ? 'updated' : 'unchanged' }
  }

  const start = async (): Promise<MutagenDaemonServiceState> => {
    const before = await describe()
    const detail = before.loaded ? await kickstart(false) : await bootstrap()
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  const stop = async (): Promise<MutagenDaemonServiceState> => {
    const detail = await bootout()
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  const restart = async (): Promise<MutagenDaemonServiceState> => {
    const before = await describe()
    const detail = before.loaded ? await kickstart(true) : await bootstrap()
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  const uninstall = async (): Promise<MutagenDaemonServiceState> => {
    let detail = await bootout()
    try {
      unlinkSync(options.unitPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        detail ??= error instanceof Error ? error.message : String(error)
      }
    }
    try {
      unlinkSync(options.wrapperPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        detail ??= error instanceof Error ? error.message : String(error)
      }
    }
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  return { describe, install, start, stop, restart, uninstall }
}
