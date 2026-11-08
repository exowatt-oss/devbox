import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MutagenDaemonServiceState, MutagenSetupServiceAction } from './hub-types'
import type { ServiceExec } from './mutagen-service'
import { renderMutagenWrapperScript, renderSystemdUnit } from './mutagen-service-wrapper'

export type SystemdServiceOptions = {
  label: string
  unitPath: string
  wrapperPath: string
  logPath: string
  home: string
  devboxVersion: string
  env: NodeJS.ProcessEnv
  exec: ServiceExec
}

type SystemdProperties = {
  activeState: string | null
  subState: string | null
  mainPid: number | null
  unitFileState: string | null
  loadState: string | null
}

function parseProperties(output: string): SystemdProperties {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      values.set(line.slice(0, separator), line.slice(separator + 1))
    }
  }
  const pid = Number(values.get('MainPID') ?? '')
  return {
    activeState: values.get('ActiveState') ?? null,
    subState: values.get('SubState') ?? null,
    mainPid: Number.isFinite(pid) && pid > 0 ? pid : null,
    unitFileState: values.get('UnitFileState') ?? null,
    loadState: values.get('LoadState') ?? null
  }
}

function unavailableDetail(stderr: string): string | null {
  return /failed to connect to bus|no such file/i.test(stderr)
    ? 'systemd --user is unavailable in this session (enable linger: sudo loginctl enable-linger $USER, or log in through systemd)'
    : null
}

function stateBase(options: SystemdServiceOptions): MutagenDaemonServiceState {
  return {
    platform: 'linux',
    manager: 'systemd-user',
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
  return unavailableDetail(result.stderr) ?? (result.stderr.trim() || result.stdout.trim() || `systemctl exited with code ${result.exitCode}`)
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

export function createSystemdService(options: SystemdServiceOptions) {
  const systemctl = async (args: readonly string[]) => {
    try {
      return await options.exec('systemctl', ['--user', ...args], { env: options.env, timeoutMs: 10_000 })
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }

  const describe = async (): Promise<MutagenDaemonServiceState> => {
    const state = stateBase(options)
    const result = await systemctl(['show', options.label, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'UnitFileState', '-p', 'LoadState'])
    if (result.exitCode !== 0) {
      return withDetail(state, commandDetail(result))
    }
    const properties = parseProperties(result.stdout)
    const loaded = ['enabled', 'static', 'linked'].includes(properties.unitFileState ?? '')
    return {
      ...state,
      loaded,
      running: properties.activeState === 'active',
      pid: properties.mainPid
    }
  }

  const run = async (args: readonly string[]): Promise<string | null> => {
    const result = await systemctl(args)
    return result.exitCode === 0 ? null : commandDetail(result)
  }

  const install = async (input: { binaryPath: string; dataDirectory: string }): Promise<{ state: MutagenDaemonServiceState; action: MutagenSetupServiceAction }> => {
    const before = await describe()
    const wrapper = renderMutagenWrapperScript({ ...input, devboxVersion: options.devboxVersion, home: options.home })
    const unit = renderSystemdUnit({ wrapperPath: options.wrapperPath, dataDirectory: input.dataDirectory, logPath: options.logPath })
    let wrapperFile: { exists: boolean; changed: boolean }
    let unitFile: { exists: boolean; changed: boolean }
    try {
      ensureDirectory(dirname(dirname(options.wrapperPath)), 0o700)
      ensureDirectory(dirname(options.wrapperPath), 0o700)
      ensureDirectory(dirname(options.logPath), 0o700)
      mkdirSync(dirname(options.unitPath), { recursive: true, mode: 0o700 })
      wrapperFile = writeIfChanged(options.wrapperPath, wrapper, 0o755)
      unitFile = writeIfChanged(options.unitPath, unit, 0o644)
    } catch (error) {
      return { state: withDetail({ ...before, installed: existsSync(options.unitPath) }, error instanceof Error ? error.message : String(error)), action: 'updated' }
    }
    const changed = wrapperFile.changed || unitFile.changed
    let detail = await run(['daemon-reload'])
    if (!detail) {
      detail = await run(['enable', '--now', options.label])
    }
    if (!detail && changed && before.running) {
      detail = await run(['restart', options.label])
    }
    const state = await describe()
    const existed = wrapperFile.exists || unitFile.exists
    return { state: detail ? withDetail(state, detail) : state, action: !existed ? 'installed' : changed ? 'updated' : 'unchanged' }
  }

  const start = async (): Promise<MutagenDaemonServiceState> => {
    const detail = await run(['start', options.label])
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  const stop = async (): Promise<MutagenDaemonServiceState> => {
    const detail = await run(['stop', options.label])
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  const restart = async (): Promise<MutagenDaemonServiceState> => {
    const detail = await run(['restart', options.label])
    const state = await describe()
    return detail ? withDetail(state, detail) : state
  }

  const uninstall = async (): Promise<MutagenDaemonServiceState> => {
    await run(['disable', '--now', options.label])
    let unlinkDetail: string | null = null
    try {
      unlinkSync(options.unitPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        unlinkDetail = error instanceof Error ? error.message : String(error)
      }
    }
    const reloadDetail = await run(['daemon-reload'])
    try {
      unlinkSync(options.wrapperPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        unlinkDetail ??= error instanceof Error ? error.message : String(error)
      }
    }
    const state = await describe()
    return withDetail(state, unlinkDetail ?? reloadDetail ?? '')
  }

  return { describe, install, start, stop, restart, uninstall }
}
