export type FlagValue = string | boolean

export type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, FlagValue>
  positionalArgs?: string[]
  passthroughArgs?: string[]
}

export type CommandSpec = {
  path: string[]
  argumentMode?: 'parsed' | 'passthrough'
  summary: string
  usage: string
  allowedFlags: string[]
  notes?: string[]
  examples?: string[]
}

export const GLOBAL_FLAGS = ['help', 'json'] as const
export const BOOLEAN_FLAGS = new Set([
  'force',
  'help',
  'json',
  'public',
  'yes',
  'consistent',
  'clear',
  'clear-default',
  'refresh',
  'no-reconnect',
  'no-login-relay',
  'list',
  'all',
  'all-devices',
  'unattached',
  'git-roaming',
  'dry-run',
  'skip-remote-prepare',
  'no-service',
  'no-pair',
  'no-remote',
  'adopt-remote',
  'allow-non-empty-local',
  'wake',
  'plain'
])

const GLOBAL_VALUE_FLAGS = new Set<string>()
/** Value flags whose bare form is meaningful (`devbox device --default` shows the current default). */
const OPTIONAL_VALUE_FLAGS = new Set(['default'])
const REPEATABLE_FLAGS = new Set(['env', 'label', 'ignore', 'exclude', 'pattern'])

function setFlag(flags: Map<string, FlagValue>, name: string, value: FlagValue): void {
  const previous = flags.get(name)
  if (REPEATABLE_FLAGS.has(name) && typeof previous === 'string' && typeof value === 'string') {
    flags.set(name, `${previous}\u0000${value}`)
    return
  }
  flags.set(name, value)
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const commandPath: string[] = []
  const positionalArgs: string[] = []
  const flags = new Map<string, FlagValue>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--') {
      return { commandPath, flags, passthroughArgs: argv.slice(index + 1) }
    }
    if (!token.startsWith('--')) {
      if (
        commandPath[0] === 'profile' &&
        (commandPath[1] === 'use' ||
          (commandPath[1] === 'env-file' && commandPath[2] === 'set') ||
          (commandPath[1] === 'shell-dir' && commandPath[2] === 'set') ||
          (commandPath[1] === 'proxy-command' && commandPath[2] === 'set') ||
          (commandPath[1] === 'device' && commandPath[2] === 'set') ||
          (commandPath[1] === 'ignore' && commandPath.length >= 3) ||
          (commandPath[1] === 'sync-max-entry-count' && commandPath.length >= 3) ||
          (commandPath[1] === 'sync-watch-polling-interval' && commandPath.length >= 3))
      ) {
        positionalArgs.push(token)
      } else if (commandPath[0] === 'shell' && commandPath.length === 1) {
        positionalArgs.push(token)
      } else {
        commandPath.push(token)
      }
      continue
    }
    const assignment = token.slice(2)
    const equals = assignment.indexOf('=')
    if (equals >= 0) {
      setFlag(flags, assignment.slice(0, equals), assignment.slice(equals + 1))
      continue
    }
    if (BOOLEAN_FLAGS.has(assignment)) {
      setFlag(flags, assignment, true)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      setFlag(flags, assignment, true)
      continue
    }
    setFlag(flags, assignment, next)
    index += 1
  }
  return {
    commandPath,
    flags,
    ...(positionalArgs.length > 0 ? { positionalArgs } : {})
  }
}

export function resolveHelpPath(parsed: ParsedArgs): string[] | null {
  if (parsed.commandPath[0] === 'help') {
    return parsed.commandPath.slice(1)
  }
  return parsed.flags.has('help') ? parsed.commandPath : null
}

export function matches(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

export function findCommandSpec(
  specs: readonly CommandSpec[],
  path: readonly string[]
): CommandSpec | undefined {
  return specs.find((spec) => matches(spec.path, path))
}

export function validateCommandAndFlags(
  specs: readonly CommandSpec[],
  parsed: ParsedArgs
): void {
  const spec = findCommandSpec(specs, parsed.commandPath)
  if (!spec) {
    throw new CliArgumentError(`Unknown command: ${parsed.commandPath.join(' ')}`)
  }
  for (const [name, value] of parsed.flags) {
    if (GLOBAL_FLAGS.includes(name as (typeof GLOBAL_FLAGS)[number])) {
      continue
    }
    if (!spec.allowedFlags.includes(name)) {
      throw new CliArgumentError(
        `Unknown flag --${name} for command: ${spec.path.join(' ')}`
      )
    }
    if (typeof value === 'boolean' && !BOOLEAN_FLAGS.has(name) && !OPTIONAL_VALUE_FLAGS.has(name)) {
      throw new CliArgumentError(`Flag --${name} requires a value.`)
    }
    if (GLOBAL_VALUE_FLAGS.has(name) && (typeof value !== 'string' || value.length === 0)) {
      throw new CliArgumentError(`Flag --${name} requires a value.`)
    }
  }
}

export class CliArgumentError extends Error {
  readonly code = 'invalid_argument' as const
  readonly data: undefined

  constructor(message: string) {
    super(message)
    this.name = 'CliArgumentError'
    this.data = undefined
  }
}
