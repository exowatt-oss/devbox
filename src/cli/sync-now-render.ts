import type { SyncNowRenderer, SyncNowRendererOptions } from './sync-now-types'
import { createLiveSyncRenderer } from './sync-now-render-live'
import { createPlainSyncRenderer } from './sync-now-render-plain'

/**
 * Terminal renderers for `db sync`.
 *
 * - `live`: an aligned status board redrawn in place on stderr (TTY), then a
 *   static summary on stdout that stays in scrollback.
 * - `plain`: UTC-stamped progress lines on stderr (launchd logs, --plain), then
 *   the same summary on stdout.
 *
 * The handler feeds every SyncNowEvent to `onEvent` and calls `close()` on every
 * exit path, Ctrl-C included; `close()` is idempotent and restores the cursor.
 */
export function createSyncNowRenderer(options: SyncNowRendererOptions): SyncNowRenderer {
  return options.mode === 'live' ? createLiveSyncRenderer(options) : createPlainSyncRenderer(options)
}
