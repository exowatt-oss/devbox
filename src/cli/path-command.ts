import { realpathSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export function findOnPath(command: string, pathValue = process.env.PATH): string | undefined {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory) {
      continue
    }
    try {
      const resolved = realpathSync(join(directory, command))
      if (resolved) {
        return resolved
      }
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined
}

export function normalizeLaunchResult(value: unknown): unknown {
  if (value && typeof value === 'object' && 'pid' in value) {
    const pid = (value as { pid?: unknown }).pid
    return { launched: true, ...(typeof pid === 'number' ? { pid } : {}) }
  }
  return value
}
