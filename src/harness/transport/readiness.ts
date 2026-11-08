import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export const TRANSPORT_FIXTURE_OPT_IN = 'DEVBOX_TRANSPORT_FIXTURE'
export const TRANSPORT_FIXTURE_BINARY = 'DEVBOX_TRANSPORT_MUTAGEN_BINARY'

export type TransportFixtureReadiness = {
  ready: boolean
  binaryPath?: string
  reason?: string
}

function executable(path: string): boolean {
  try {
    return (
      statSync(path).isFile() &&
      (process.platform === 'win32' || accessSync(path, constants.X_OK) === undefined)
    )
  } catch {
    return false
  }
}

function findOnPath(command: string, environment: NodeJS.ProcessEnv): string | undefined {
  const names = process.platform === 'win32' ? [`${command}.exe`, command] : [command]
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (isAbsolute(candidate) && executable(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

export function transportFixtureReadiness(
  environment: NodeJS.ProcessEnv = process.env
): TransportFixtureReadiness {
  const optIn = environment[TRANSPORT_FIXTURE_OPT_IN] === '1'
  const configured = environment[TRANSPORT_FIXTURE_BINARY]
  const binaryPath = configured
    ? isAbsolute(configured) && executable(configured)
      ? configured
      : undefined
    : findOnPath('mutagen', environment)

  if (!optIn && !binaryPath) {
    return {
      ready: false,
      reason:
        `SKIPPED: provide ${TRANSPORT_FIXTURE_OPT_IN}=1 and a real Mutagen v0.18.1 binary ` +
        `on PATH or at ${TRANSPORT_FIXTURE_BINARY}=/absolute/path/to/mutagen; ` +
        'the opt-in is disabled, so no Mutagen, SSH, rsync, or Docker process is attempted.'
    }
  }
  if (!optIn) {
    return {
      ready: false,
      binaryPath,
      reason:
        `SKIPPED: set ${TRANSPORT_FIXTURE_OPT_IN}=1 to opt into the real external transport ` +
        'fixture; a candidate binary was found but will not be invoked without explicit opt-in.'
    }
  }
  if (!binaryPath) {
    return {
      ready: false,
      reason:
        `SKIPPED: ${TRANSPORT_FIXTURE_OPT_IN}=1 is set, but no executable Mutagen binary was ` +
        `found; put real Mutagen v0.18.1 on PATH or set ` +
        `${TRANSPORT_FIXTURE_BINARY}=/absolute/path/to/mutagen.`
    }
  }
  return { ready: true, binaryPath }
}

export function skipName(readiness: TransportFixtureReadiness): string {
  return readiness.ready
    ? 'real Mutagen external transport'
    : `real Mutagen external transport (${readiness.reason})`
}
