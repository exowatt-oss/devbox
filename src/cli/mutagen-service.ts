import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { commandExecFileAsync } from '../shared/exec'
import {
  MUTAGEN_SERVICE_LAUNCHD_LABEL,
  MUTAGEN_SERVICE_LOG_RELATIVE,
  MUTAGEN_SERVICE_SYSTEMD_UNIT,
  MUTAGEN_SERVICE_WRAPPER_RELATIVE,
  type HubPlatform,
  type MutagenDaemonServiceState,
  type MutagenLogsResult,
  type MutagenSetupServiceAction,
  type MutagenServiceManager
} from './hub-types'
import { createLaunchdService, type LaunchdServiceOptions } from './mutagen-service-launchd'
import { createSystemdService, type SystemdServiceOptions } from './mutagen-service-systemd'

export type ServiceExecResult = { exitCode: number; stdout: string; stderr: string }
export type ServiceExec = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<ServiceExecResult>

export const defaultServiceExec: ServiceExec = async (command, args, options) => {
  try {
    const result = await commandExecFileAsync(command, [...args], {
      env: options?.env,
      timeout: options?.timeoutMs
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }
    const exitCode = typeof candidate.code === 'number' ? candidate.code : candidate.code === 'ENOENT' ? 127 : 1
    const stderr = typeof candidate.stderr === 'string' && candidate.stderr ? candidate.stderr : typeof candidate.message === 'string' ? candidate.message : ''
    return {
      exitCode,
      stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
      stderr
    }
  }
}

export type MutagenServiceOptions = {
  stateRoot: string
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  devboxVersion: string
  exec?: ServiceExec
  uid?: number
}

export type MutagenServiceInstallInput = { binaryPath: string; dataDirectory: string }

export type MutagenDaemonService = {
  describe(): Promise<MutagenDaemonServiceState>
  install(input: MutagenServiceInstallInput): Promise<{ state: MutagenDaemonServiceState; action: MutagenSetupServiceAction }>
  uninstall(): Promise<MutagenDaemonServiceState>
  start(): Promise<MutagenDaemonServiceState>
  stop(): Promise<MutagenDaemonServiceState>
  restart(): Promise<MutagenDaemonServiceState>
  readLog(lines: number): Promise<MutagenLogsResult>
}

type ServicePaths = ReturnType<typeof mutagenServicePaths>

export function mutagenServicePaths(options: Pick<MutagenServiceOptions, 'stateRoot' | 'home' | 'platform' | 'env'>): {
  platform: HubPlatform
  manager: MutagenServiceManager
  label: string
  unitPath: string
  wrapperPath: string
  logPath: string
} {
  const wrapperPath = join(options.stateRoot, MUTAGEN_SERVICE_WRAPPER_RELATIVE)
  const logPath = join(options.stateRoot, MUTAGEN_SERVICE_LOG_RELATIVE)
  if (options.platform === 'darwin') {
    const label = MUTAGEN_SERVICE_LAUNCHD_LABEL
    return {
      platform: 'darwin',
      manager: 'launchd',
      label,
      unitPath: join(options.home, 'Library/LaunchAgents', `${label}.plist`),
      wrapperPath,
      logPath
    }
  }
  if (options.platform === 'linux') {
    const label = MUTAGEN_SERVICE_SYSTEMD_UNIT
    const configHome = options.env.XDG_CONFIG_HOME?.trim() || join(options.home, '.config')
    return {
      platform: 'linux',
      manager: 'systemd-user',
      label,
      unitPath: join(configHome, 'systemd/user', label),
      wrapperPath,
      logPath
    }
  }
  return { platform: 'unsupported', manager: 'none', label: '', unitPath: '', wrapperPath, logPath }
}

export function detectLegacyWrapper(home: string, canonicalWrapperPath: string): string | null {
  const legacyPath = join(home, '.local/bin/devbox-mutagen-daemon')
  if (legacyPath === canonicalWrapperPath || !existsSync(legacyPath)) {
    return null
  }
  try {
    return statSync(legacyPath).isFile() ? legacyPath : null
  } catch {
    return null
  }
}

function unsupportedState(paths: ServicePaths, platform: NodeJS.Platform): MutagenDaemonServiceState {
  return {
    platform: 'unsupported',
    manager: 'none',
    label: '',
    unitPath: '',
    wrapperPath: paths.wrapperPath,
    logPath: paths.logPath,
    installed: false,
    loaded: false,
    running: false,
    pid: null,
    detail: `no supported service manager on ${platform}`
  }
}

function createManager(options: MutagenServiceOptions, paths: ServicePaths, exec: ServiceExec) {
  if (paths.manager === 'launchd') {
    const managerOptions: LaunchdServiceOptions = {
      ...paths,
      stateRoot: options.stateRoot,
      home: options.home,
      devboxVersion: options.devboxVersion,
      env: options.env,
      exec,
      uid: options.uid ?? process.getuid?.() ?? 501
    }
    return createLaunchdService(managerOptions)
  }
  if (paths.manager === 'systemd-user') {
    const managerOptions: SystemdServiceOptions = {
      ...paths,
      home: options.home,
      devboxVersion: options.devboxVersion,
      env: options.env,
      exec
    }
    return createSystemdService(managerOptions)
  }
  return null
}

export function createMutagenDaemonService(options: MutagenServiceOptions): MutagenDaemonService {
  const paths = mutagenServicePaths(options)
  const exec = options.exec ?? defaultServiceExec
  const manager = createManager(options, paths, exec)
  const describe = async (): Promise<MutagenDaemonServiceState> => manager?.describe() ?? unsupportedState(paths, options.platform)
  const install = async (input: MutagenServiceInstallInput): Promise<{ state: MutagenDaemonServiceState; action: MutagenSetupServiceAction }> => manager?.install(input) ?? { state: unsupportedState(paths, options.platform), action: 'unsupported' }
  const uninstall = async (): Promise<MutagenDaemonServiceState> => manager?.uninstall() ?? unsupportedState(paths, options.platform)
  const start = async (): Promise<MutagenDaemonServiceState> => manager?.start() ?? unsupportedState(paths, options.platform)
  const stop = async (): Promise<MutagenDaemonServiceState> => manager?.stop() ?? unsupportedState(paths, options.platform)
  const restart = async (): Promise<MutagenDaemonServiceState> => manager?.restart() ?? unsupportedState(paths, options.platform)
  const readLog = async (lines: number): Promise<MutagenLogsResult> => {
    if (!existsSync(paths.logPath)) {
      return { logPath: paths.logPath, exists: false, lines: [] }
    }
    const count = Math.max(0, Math.floor(lines))
    if (count === 0) {
      return { logPath: paths.logPath, exists: true, lines: [] }
    }
    const content = readFileSync(paths.logPath, 'utf8').replace(/\r\n/g, '\n')
    if (content.length === 0) {
      return { logPath: paths.logPath, exists: true, lines: [] }
    }
    const allLines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
    return { logPath: paths.logPath, exists: true, lines: allLines.slice(-count) }
  }
  return { describe, install, uninstall, start, stop, restart, readLog }
}

export { parseLaunchctlPrint } from './mutagen-service-launchd'
