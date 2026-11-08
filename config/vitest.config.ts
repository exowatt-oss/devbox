import { defineConfig } from 'vitest/config'

const windowsWorkerCap = process.platform === 'win32' ? { maxWorkers: 4 } : {}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'config/scripts/**/*.test.mjs'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    root: new URL('..', import.meta.url).pathname,
    ...windowsWorkerCap
  }
})
