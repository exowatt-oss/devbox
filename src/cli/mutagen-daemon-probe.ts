import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MutagenDaemonProbe } from './hub-types'
import { defaultServiceExec, type ServiceExec, type ServiceExecResult } from './mutagen-service'

const PROBE_EXEC_TIMEOUT_MS = 2_000

export type ProbeMutagenDaemonOptions = {
  dataDirectory: string
  binaryPath: string | null
  platform: NodeJS.Platform
  exec?: ServiceExec
  servicePid?: number | null
  now?: () => number
}

type ProcessCandidate = { pid: number; ppid: number; command: string }

async function runProbeExec(exec: ServiceExec, command: string, args: readonly string[]): Promise<ServiceExecResult> {
  try {
    return await exec(command, args, { timeoutMs: PROBE_EXEC_TIMEOUT_MS })
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

function isExactMutagenDaemonCommand(command: string): boolean {
  return /(?:^|\/)mutagen[ \t]+daemon[ \t]+run$/.test(command)
}

function isDarwinMutagenDaemonCommand(output: string): boolean {
  return /(?:^|[ \t/])mutagen[ \t]+daemon[ \t]+run(?:[ \t\r\n]|$)/.test(output)
}

function parsePsCandidates(output: string): ProcessCandidate[] {
  const candidates: ProcessCandidate[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (match && isExactMutagenDaemonCommand(match[3])) {
      candidates.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
    }
  }
  return candidates
}

function parsePids(output: string): number[] {
  return output.split(/\s+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
}

function hasDataDirectory(output: string, dataDirectory: string): boolean {
  const marker = `MUTAGEN_DATA_DIRECTORY=${dataDirectory}`
  return output.split(/\r?\n/).some((line) => {
    const index = line.indexOf(marker)
    if (index < 0 || (index > 0 && !/\s/.test(line[index - 1]!))) {
      return false
    }
    const next = line[index + marker.length]
    return next === undefined || /\s/.test(next)
  })
}

function newestArchiveMtime(dataDirectory: string): number | null {
  const archiveDirectory = join(dataDirectory, 'archives')
  let names: string[]
  try {
    names = readdirSync(archiveDirectory)
  } catch {
    return null
  }
  let newest: number | null = null
  for (const name of names) {
    try {
      const stats = statSync(join(archiveDirectory, name))
      if (newest === null || stats.mtimeMs > newest) {
        newest = stats.mtimeMs
      }
    } catch {
      // An archive may disappear while a cycle is completing.
    }
  }
  return newest
}

type CandidateSearch = { candidate: ProcessCandidate | null; available: boolean }

async function findLinuxCandidate(options: ProbeMutagenDaemonOptions, exec: ServiceExec): Promise<CandidateSearch> {
  const processList = await runProbeExec(exec, 'ps', ['-axo', 'pid=,ppid=,command='])
  if (processList.exitCode !== 0) {
    return { candidate: null, available: false }
  }
  const candidates = parsePsCandidates(processList.stdout)
  for (const candidate of candidates) {
    const environment = await runProbeExec(exec, 'sh', ['-c', `cat /proc/${candidate.pid}/environ | tr '\\0' '\\n'`])
    if (environment.exitCode === 0 && hasDataDirectory(environment.stdout, options.dataDirectory)) {
      return { candidate, available: true }
    }
  }
  return { candidate: null, available: true }
}

async function findDarwinCandidate(options: ProbeMutagenDaemonOptions, exec: ServiceExec): Promise<CandidateSearch> {
  const lockPath = join(options.dataDirectory, 'daemon/daemon.lock')
  const lockResult = await runProbeExec(exec, 'lsof', ['-t', '--', lockPath])
  const preferredPids = lockResult.exitCode === 0 ? parsePids(lockResult.stdout) : []
  let psAvailable = true
  const inspect = async (pid: number, lockHolder: boolean): Promise<ProcessCandidate | null> => {
    const processResult = await runProbeExec(exec, 'ps', ['-E', '-o', 'command=', '-p', String(pid)])
    if (processResult.exitCode !== 0) {
      psAvailable = false
      return lockHolder ? { pid, ppid: 0, command: '' } : null
    }
    if (!hasDataDirectory(processResult.stdout, options.dataDirectory) || !isDarwinMutagenDaemonCommand(processResult.stdout)) {
      return null
    }
    const command = processResult.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
    return { pid, ppid: 0, command }
  }
  for (const pid of preferredPids) {
    const candidate = await inspect(pid, true)
    if (candidate) {
      return { candidate, available: psAvailable }
    }
  }
  const processList = await runProbeExec(exec, 'ps', ['-axo', 'pid=,ppid=,command='])
  if (processList.exitCode !== 0) {
    return { candidate: null, available: false }
  }
  for (const candidate of parsePsCandidates(processList.stdout)) {
    const inspected = await inspect(candidate.pid, false)
    if (inspected) {
      return { candidate: { ...inspected, ppid: candidate.ppid }, available: psAvailable }
    }
  }
  return { candidate: null, available: psAvailable }
}

async function hasServiceAncestor(pid: number, servicePid: number, exec: ServiceExec): Promise<boolean> {
  let current = pid
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === servicePid) {
      return true
    }
    const result = await runProbeExec(exec, 'ps', ['-o', 'ppid=', '-p', String(current)])
    if (result.exitCode !== 0) {
      return false
    }
    const parent = Number(result.stdout.trim())
    if (!Number.isInteger(parent) || parent <= 0 || parent === current) {
      return false
    }
    current = parent
  }
  return current === servicePid
}

async function readVersion(binaryPath: string | null, exec: ServiceExec): Promise<string | null> {
  if (!binaryPath) {
    return null
  }
  const result = await runProbeExec(exec, binaryPath, ['version'])
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout.trim().split(/\r?\n/, 1)[0] || null
}

export async function probeMutagenDaemon(options: ProbeMutagenDaemonOptions): Promise<MutagenDaemonProbe> {
  const exec = options.exec ?? defaultServiceExec
  let search: CandidateSearch = { candidate: null, available: true }
  if (options.platform === 'linux') {
    search = await findLinuxCandidate(options, exec)
  } else if (options.platform === 'darwin') {
    search = await findDarwinCandidate(options, exec)
  }
  const candidate = search.candidate
  const running = candidate !== null
  let origin: MutagenDaemonProbe['origin'] = search.available ? 'none' : 'unknown'
  if (candidate) {
    if (options.servicePid === null || options.servicePid === undefined) {
      origin = 'unknown'
    } else {
      origin = await hasServiceAncestor(candidate.pid, options.servicePid, exec) ? 'service' : 'on-demand'
    }
  }
  return {
    running,
    pid: candidate?.pid ?? null,
    origin,
    binaryPath: options.binaryPath,
    version: await readVersion(options.binaryPath, exec),
    dataDirectory: options.dataDirectory,
    lastCycleAt: newestArchiveMtime(options.dataDirectory)
  }
}

export { parseLaunchctlPrint } from './mutagen-service-launchd'
