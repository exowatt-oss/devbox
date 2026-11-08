import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { formatMs, runBounded } from './sync-now-exec'

/**
 * Optional per-profile sync hooks: `<state root>/hooks/sync/<profileId>`, run as
 * `<hook> before` (after the machine answered, before its sessions resume) and
 * `<hook> after` (once every lane of that profile flushed, even if another profile on the
 * machine stalled or hit the cap). Missing or non-executable = no-op;
 * a failing hook never fails the sync, it becomes a warning.
 */
export type SyncHookPhase = 'before' | 'after'

export type SyncHookContext = { profileId: string; host: string; user: string }

export type SyncHooks = {
  /** Executable hook path for a profile, else undefined. */
  find(profileId: string): string | undefined
  /** Resolves undefined on success, else a one-line warning. Never rejects. */
  run(path: string, phase: SyncHookPhase, context: SyncHookContext, signal: AbortSignal): Promise<string | undefined>
}

export const SYNC_HOOK_TIMEOUT_MS = 120_000

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export function syncHooksDirectory(stateRoot: string): string {
  return join(stateRoot, 'hooks', 'sync')
}

export function createSyncHooks(options: { stateRoot: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): SyncHooks {
  const directory = syncHooksDirectory(options.stateRoot)
  const timeoutMs = options.timeoutMs ?? SYNC_HOOK_TIMEOUT_MS
  return {
    find(profileId) {
      if (!PROFILE_ID.test(profileId)) {return undefined}
      const path = join(directory, profileId)
      try {
        if (!statSync(path).isFile()) {return undefined}
        accessSync(path, constants.X_OK)
        return path
      } catch {
        return undefined
      }
    },
    run: (path, phase, context, signal) => runHook(path, phase, context, signal, options.env, timeoutMs)
  }
}

async function runHook(
  path: string,
  phase: SyncHookPhase,
  context: SyncHookContext,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string | undefined> {
  const name = `hook ${context.profileId} ${phase}`
  if (signal.aborted) {return `${name} skipped: interrupted`}
  const result = await runBounded(path, [phase], {
    timeoutMs,
    signal,
    env: { ...env, DEVBOX_SYNC_PHASE: phase, DEVBOX_SYNC_PROFILE: context.profileId, DEVBOX_SYNC_HOST: context.host, DEVBOX_SYNC_USER: context.user }
  })
  if (result.spawnError !== undefined) {return `${name} could not run: ${result.spawnError}`}
  if (result.aborted) {return `${name} interrupted`}
  if (result.timedOut) {return `${name} timed out after ${formatMs(timeoutMs)}`}
  if (result.code === 0) {return undefined}
  const last = result.stderr.split(/\r?\n/u).map((line) => line.trim()).findLast((line) => line.length > 0)
  return `${name} failed (exit ${result.code ?? 'signal'})${last ? `: ${last}` : ''}`
}
