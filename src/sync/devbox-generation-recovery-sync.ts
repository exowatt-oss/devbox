import type { DevboxSyncBackend } from './devbox-sync-backend'
import { recoverGenerationRoot } from './devbox-generation-recovery'

export async function recoverGenerationWithSync(
  generationsRoot: string,
  sync: Pick<DevboxSyncBackend, 'resume'>
): Promise<boolean> {
  await recoverGenerationRoot(generationsRoot)
  try {
    await sync.resume()
    return true
  } catch {
    return false
  }
}
