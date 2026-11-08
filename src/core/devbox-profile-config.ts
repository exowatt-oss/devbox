import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

export const DEVBOX_CONFIG_SCHEMA_VERSION = 1 as const

export type DevboxConfig = {
  schemaVersion: typeof DEVBOX_CONFIG_SCHEMA_VERSION
  defaultProfile?: string
}

type ConfigRecord = Record<string, unknown>
const object = (value: unknown): value is ConfigRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const profileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)

/** Small, non-secret, user preference storage for the standalone CLI. */
export class DevboxProfileConfigStore {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  load(): DevboxConfig {
    if (!existsSync(this.path)) {
      return { schemaVersion: DEVBOX_CONFIG_SCHEMA_VERSION }
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!object(parsed) || parsed.schemaVersion !== DEVBOX_CONFIG_SCHEMA_VERSION) {
        return { schemaVersion: DEVBOX_CONFIG_SCHEMA_VERSION }
      }
      return {
        schemaVersion: DEVBOX_CONFIG_SCHEMA_VERSION,
        ...(profileId(parsed.defaultProfile) ? { defaultProfile: parsed.defaultProfile } : {})
      }
    } catch {
      // A damaged preference must never make all profiles unusable. The next
      // explicit `profile use` replaces it with a valid config.
      return { schemaVersion: DEVBOX_CONFIG_SCHEMA_VERSION }
    }
  }

  getDefaultProfile(): string | undefined {
    return this.load().defaultProfile
  }

  setDefaultProfile(defaultProfile: string | undefined): DevboxConfig {
    if (defaultProfile !== undefined && !profileId(defaultProfile)) {
      throw new Error('Invalid Devbox profile identifier.')
    }
    const config: DevboxConfig = {
      schemaVersion: DEVBOX_CONFIG_SCHEMA_VERSION,
      ...(defaultProfile === undefined ? {} : { defaultProfile })
    }
    this.write(config)
    return config
  }

  private write(config: DevboxConfig): void {
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const fd = openSync(tmpPath, 'w', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, this.path)
  }
}
