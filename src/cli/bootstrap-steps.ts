import type { BootstrapProgress, BootstrapStep, BootstrapStepStatus } from './hub-types'

export class BootstrapAbort extends Error {
  readonly step: BootstrapStep

  constructor(step: BootstrapStep) {
    super(step.detail)
    this.name = 'BootstrapAbort'
    this.step = step
  }
}

export function createStepRunner(progress?: BootstrapProgress): {
  run(id: string, fn: () => Promise<{ status?: BootstrapStepStatus; detail: string }>): Promise<BootstrapStep>
  skip(id: string, detail: string): BootstrapStep
  steps(): readonly BootstrapStep[]
} {
  const completed: BootstrapStep[] = []
  const run = async (id: string, fn: () => Promise<{ status?: BootstrapStepStatus; detail: string }>): Promise<BootstrapStep> => {
    const started = Date.now()
    try {
      const result = await fn()
      const step: BootstrapStep = { id, status: result.status ?? 'ok', detail: result.detail, durationMs: Date.now() - started }
      completed.push(step)
      progress?.(step)
      return step
    } catch (error) {
      const step: BootstrapStep = { id, status: 'failed', detail: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }
      completed.push(step)
      progress?.(step)
      throw new BootstrapAbort(step)
    }
  }
  const skip = (id: string, detail: string): BootstrapStep => {
    const step = { id, status: 'skipped' as const, detail }
    completed.push(step)
    progress?.(step)
    return step
  }
  return { run, skip, steps: () => [...completed] }
}
