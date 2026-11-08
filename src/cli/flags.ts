import { CliArgumentError, type FlagValue } from './args'

export function getRequiredStringFlag(flags: Map<string, FlagValue>, name: string): string {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new CliArgumentError(`Missing required --${name}`)
}

export function getOptionalStringFlag(
  flags: Map<string, FlagValue>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function getOptionalNumberFlag(
  flags: Map<string, FlagValue>,
  name: string
): number | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new CliArgumentError(`Invalid numeric value for --${name}`)
  }
  return parsed
}

export function getOptionalNonNegativeIntegerFlag(
  flags: Map<string, FlagValue>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliArgumentError(`--${name} must be a non-negative integer.`)
  }
  return value
}

export function getOptionalPositiveIntegerFlag(
  flags: Map<string, FlagValue>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliArgumentError(`--${name} must be a positive integer.`)
  }
  return value
}

export function getRequiredPortFlag(flags: Map<string, FlagValue>, name: string): number {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new CliArgumentError(`--${name} must be an integer between 1 and 65535.`)
  }
  return value
}

export function getRepeatedStringFlag(
  flags: Map<string, FlagValue>,
  name: string
): string[] {
  const value = getOptionalStringFlag(flags, name)
  return value === undefined ? [] : value.split('\u0000').filter(Boolean)
}
