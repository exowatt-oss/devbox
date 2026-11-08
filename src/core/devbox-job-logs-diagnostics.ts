import { resolve } from 'node:path'

const registeredPaths = new Set<string>()

/** Register one app-owned workload-log family for default-bundle exclusion. */
export function registerDevboxJobLogPath(filePath: string): void {
  registeredPaths.add(resolve(filePath))
}

/** True only for a registered current log or its one-file rotation. */
export function isDevboxJobWorkloadLogPath(filePath: string): boolean {
  const resolvedPath = resolve(filePath)
  for (const currentPath of registeredPaths) {
    if (resolvedPath === currentPath || resolvedPath === `${currentPath}.1`) {
      return true
    }
  }
  return false
}
