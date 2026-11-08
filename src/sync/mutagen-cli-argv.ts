import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { commandExecFileAsync } from '../shared/exec'
import type { DevboxSyncCreateRequest } from './devbox-sync-backend'
import { DEVBOX_SYNC_EXCLUSIONS, renderMutagenIgnoreArguments } from './devbox-sync-exclusions'
import { createDevboxError, type DevboxError } from '../shared/devbox-errors'
import {
  MUTAGEN_DEFAULT_MAX_ENTRY_COUNT,
  MUTAGEN_JSON_TEMPLATE,
  MUTAGEN_POLLING_INTERVAL_SECONDS,
  type MutagenCommandRunner,
  type MutagenCreateSessionOptions
} from './mutagen-cli-types'

export const createMutagenCommandFailure = (
  profileId: string,
  detail = 'Mutagen command failed.'
): DevboxError =>
  createDevboxError('unknown', {
    message: detail,
    retryable: true,
    context: { profileId, phase: 'sync' }
  })

export const createMutagenOperationConflict = (profileId: string, field: string): DevboxError =>
  createDevboxError('operation_conflict', { context: { profileId, field } })

export const defaultMutagenCommandRunner: MutagenCommandRunner = async (command, args, options) => {
  try {
    const result = await commandExecFileAsync(command, [...args], {
      env: options.env,
      signal: options.signal
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    return {
      exitCode: typeof candidate.code === 'number' ? candidate.code : 1,
      stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
      stderr: typeof candidate.stderr === 'string' ? candidate.stderr : ''
    }
  }
}

export function requireAbsoluteAppPath(path: string, appDataRoot: string, field: string): string {
  const absolute = resolve(path)
  const root = resolve(appDataRoot)
  if (
    !isAbsolute(path) ||
    absolute !== path ||
    !isAbsolute(appDataRoot) ||
    root === absolute ||
    !absolute.startsWith(`${root}/`) ||
    absolute === resolve(homedir(), '.mutagen') ||
    absolute.startsWith(`${resolve(homedir(), '.mutagen')}/`)
  ) {
    throw createMutagenOperationConflict('unknown', field)
  }
  return absolute
}

export function validateMutagenBinaryPath(binaryPath: string, profileId: string): void {
  if (!isAbsolute(binaryPath) || binaryPath !== resolve(binaryPath)) {
    throw createMutagenOperationConflict(profileId, 'mutagen-binary-path')
  }
}

function mutagenModeFor(mode: DevboxSyncCreateRequest['mode']): string {
  switch (mode) {
    case 'two-way-resolved':
      return 'two-way-resolved'
    case 'one-way-replica':
      return 'one-way-replica'
    case 'two-way-safe':
    case 'directional':
      return 'two-way-safe'
  }
}

export function buildMutagenCreateArgs(
  request: DevboxSyncCreateRequest,
  options: MutagenCreateSessionOptions
): string[] {
  const explicitOnly =
    request.exclusionPolicy === 'explicit-only' ||
    (request.exclusionPolicy === undefined && options.exclusionPolicy === 'explicit-only')
  const excludes = explicitOnly
    ? options.excludes ?? request.excludes ?? []
    : [...new Set([...DEVBOX_SYNC_EXCLUSIONS, ...(options.excludes ?? request.excludes ?? [])])]
  const args: string[] = [
    'sync',
    'create',
    // Devbox never leaves a session live: it is born paused and only `db sync` resumes,
    // flushes, and pauses it again.
    '--paused',
    '--no-global-configuration',
    `--mode=${mutagenModeFor(request.mode)}`,
    `--name=${options.name}`,
    '--permissions-mode=portable',
    '--default-file-mode=0600',
    '--default-directory-mode=0700',
    '--symlink-mode=portable',
    `--watch-mode=${options.watchMode ?? 'portable'}`,
    `--watch-polling-interval=${options.pollingIntervalSeconds ?? request.watchPollingIntervalSeconds ?? MUTAGEN_POLLING_INTERVAL_SECONDS}`,
    '--stage-mode=neighboring',
    `--max-entry-count=${options.maxEntryCount ?? MUTAGEN_DEFAULT_MAX_ENTRY_COUNT}`,
    // No default staging cap: Mutagen retries (not skips) over-cap files every cycle.
    ...(options.maxStagingFileSize ? [`--max-staging-file-size=${options.maxStagingFileSize}`] : []),
    '--ignore-vcs'
  ]
  for (const [key, value] of Object.entries(options.labels)) {
    args.push(`--label=${key}=${value}`)
  }
  args.push(...renderMutagenIgnoreArguments(excludes))
  args.push('--', request.localRoot, options.remoteEndpoint)
  return args
}

export function buildMutagenMonitorArgs(sessionId: string): string[] {
  return ['sync', 'monitor', `--template=${MUTAGEN_JSON_TEMPLATE}`, sessionId]
}

export function buildMutagenActionArgs(
  action: 'pause' | 'resume' | 'flush' | 'terminate',
  sessionId: string
): string[] {
  return ['sync', action, sessionId]
}

export function buildMutagenStateArgs(prefix: readonly string[]): string[] {
  return [...prefix, `--template=${MUTAGEN_JSON_TEMPLATE}`]
}

export function buildMutagenDaemonArgs(action: 'start' | 'stop'): string[] {
  return ['daemon', action]
}
