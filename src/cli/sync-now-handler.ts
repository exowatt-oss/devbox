import { CliArgumentError } from './args'
import { getOptionalNonNegativeIntegerFlag, getOptionalStringFlag } from './flags'
import { formatDevboxStage, printDevboxResult } from './format'
import type { CommandHandler, HandlerContext } from './handlers'
import { operationKey } from './operation-key'
import { createPresentation } from './presentation'
import { unicodeEnabled } from './presentation-ansi'
import { SYNC_NOW_DEFAULT_TIMEOUT_SECONDS } from './sync-now'
import type { SyncNowSelection } from './sync-now-plan'
import { createSyncNowRenderer } from './sync-now-render'
import type { SyncNowRenderer, SyncNowRendererOptions, SyncNowResult } from './sync-now-types'

/** Process seams for `db sync`, injectable so tests never touch real signals or exit. */
export type SyncNowHandlerIo = {
  stdout: SyncNowRendererOptions['stdout']
  stderr: SyncNowRendererOptions['stderr']
  /** Subscribe to Ctrl-C / SIGTERM; returns the unsubscribe. */
  onInterrupt: (handler: () => void) => () => void
  hardExit: (code: number) => void
  createRenderer: (options: SyncNowRendererOptions) => SyncNowRenderer
}

const processIo: SyncNowHandlerIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  onInterrupt: (handler) => {
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
    return () => {
      process.removeListener('SIGINT', handler)
      process.removeListener('SIGTERM', handler)
    }
  },
  hardExit: (code) => process.exit(code),
  createRenderer: createSyncNowRenderer
}

/** Exit codes: 0 nothing failed (skips are expected), 1 a machine failed, 130 interrupted. */
export function syncNowExitCode(result: Pick<SyncNowResult, 'interrupted' | 'failedCount'>): number {
  if (result.interrupted) {return 130}
  return result.failedCount > 0 ? 1 : 0
}

export function createSyncNowHandler(io: SyncNowHandlerIo = processIo): CommandHandler {
  return async (ctx: HandlerContext) => {
    const syncNow = ctx.service.syncNow?.bind(ctx.service)
    if (syncNow === undefined) {throw new CliArgumentError('devbox sync is unavailable in this service.')}
    if ((ctx.positionalArgs ?? []).length > 0 || (ctx.rawArgs ?? []).length > 0) {
      throw new CliArgumentError('devbox sync takes no arguments; narrow it with --profile <id> or --device <alias>.')
    }
    const timeoutSeconds = getOptionalNonNegativeIntegerFlag(ctx.flags, 'timeout') ?? SYNC_NOW_DEFAULT_TIMEOUT_SECONDS
    const presentationOptions = ctx.presentation ?? { output: process.stdout, env: process.env }
    const renderer = ctx.json ? undefined : io.createRenderer({
      mode: ctx.flags.get('plain') !== true && io.stderr.isTTY === true ? 'live' : 'plain',
      stdout: io.stdout,
      stderr: io.stderr,
      presentation: createPresentation(presentationOptions),
      glyphs: unicodeEnabled(presentationOptions)
    })
    const controller = new AbortController()
    let interrupts = 0
    const unsubscribe = io.onInterrupt(() => {
      interrupts += 1
      if (interrupts === 1) {
        controller.abort()
        return
      }
      renderer?.close()
      // The board is gone and no summary follows; say what happened and what is still settling.
      io.stderr.write('db sync stopped at once (second Ctrl-C); the sessions it resumed are being paused in the background\n')
      io.hardExit(130)
    })
    let result: SyncNowResult
    try {
      result = await syncNow(
        { selection: syncSelection(ctx.flags), wake: ctx.flags.get('wake') === true, timeoutMs: timeoutSeconds * 1_000 },
        (event) => renderer?.onEvent(event),
        controller.signal
      )
    } finally {
      unsubscribe()
      renderer?.close()
    }
    if (ctx.json) {
      const key = operationKey('sync', result, getOptionalStringFlag(ctx.flags, 'operation-key'))
      printDevboxResult('sync', 'sync', result, key, true, formatDevboxStage)
    }
    process.exitCode = syncNowExitCode(result)
  }
}

/**
 * No flags = every machine. `--device` narrows to machines (index.ts mirrors it into
 * --profile, so it wins); `--profile` narrows to that profile's lanes.
 */
export function syncSelection(flags: ReadonlyMap<string, string | boolean>): SyncNowSelection {
  const read = (name: string): string | undefined => {
    const value = flags.get(name)
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  }
  const device = read('device')
  if (device !== undefined) {return { device }}
  const profile = read('profile')
  return profile === undefined ? {} : { profile }
}

export const handleSyncNow: CommandHandler = (ctx) => createSyncNowHandler()(ctx)
