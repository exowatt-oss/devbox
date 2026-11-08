import { removeDevboxCredentialEnv } from '../core/devbox-credential-env'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'

/** Cleanup is deliberately best effort: shutdown must not print or retain secret material. */
export async function bestEffortRemoveDevboxCredentialEnv(
  profileId: string,
  resolveRunner: () => DevboxSshRunner
): Promise<void> {
  try {
    await removeDevboxCredentialEnv(resolveRunner(), profileId)
  } catch {
    // The host may be offline during shutdown or cleanup.
  }
}
