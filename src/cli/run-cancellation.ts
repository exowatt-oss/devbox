import type { DevboxRunArgs } from '../shared/devbox-ipc'
import type { DevboxServiceLike } from './operations'

export async function runWithCancellation(
  service: DevboxServiceLike,
  profileId: string,
  job: DevboxRunArgs['job'],
  attach: boolean,
  waitForJob: (service: DevboxServiceLike, profileId: string, jobId: string) => Promise<unknown>,
  asRecord: (value: unknown) => Record<string, unknown>
): Promise<unknown> {
  let interrupted = false
  let cancellation: Promise<unknown> | undefined
  let resolveSignal: (() => void) | undefined
  const onInterrupt = (): void => {
    interrupted = true
    resolveSignal?.()
    cancellation ??= service.cancelJob(profileId, job.id).catch(() => undefined)
  }
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve
    process.once('SIGINT', onInterrupt)
  })
  try {
    const operation = service.runConsistent(profileId, job)
    const value = await Promise.race([operation, signal.then(() => ({ interrupted: true }))])
    if (cancellation) { await cancellation }
    if (interrupted) { process.exitCode = 130 }
    if (attach && !interrupted) {
      const completed = await waitForJob(service, profileId, job.id)
      return { ...asRecord(value), job: completed }
    }
    return value
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}
