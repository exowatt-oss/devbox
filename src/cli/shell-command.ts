import { CliArgumentError, type FlagValue } from './args'

export type DevboxShellCommand =
  | { verb: 'attach'; target?: string; noReconnect: boolean; noLoginRelay: boolean }
  | { verb: 'new'; name?: string; cwd?: string; run?: string; noReconnect: boolean; noLoginRelay: boolean }
  | { verb: 'resume'; noReconnect: boolean; noLoginRelay: boolean }
  | { verb: 'reconnect-all'; dryRun: boolean; worktree?: string }
  | { verb: 'list' }
  | { verb: 'remove'; target?: string; all: boolean; unattached?: boolean; allDevices: boolean }

const SHELL_USAGE = 'Usage: devbox shell [<id-or-name>] [--no-reconnect] [--no-login-relay] [--profile <id>|--device <name>] | new [name] [--cwd <remote-dir>] [--run <command>] [--no-reconnect] [--no-login-relay] [--profile <id>|--device <name>] | resume [--no-reconnect] [--no-login-relay] [--profile <id>|--device <name>] | reconnect [--all [--dry-run] [--worktree <selector>]] | ls | rm <id-or-name> | rm this | rm --all | rm --unattached [--all-devices]'

/**
 * Parse the shell-only verbs while keeping the top-level CLI parser small.
 * Legacy v0.1.5 flags deliberately remain accepted here as hidden aliases.
 */
export function parseDevboxShellCommand(
  positionalArgs: readonly string[],
  flags: ReadonlyMap<string, FlagValue>
): DevboxShellCommand {
  const list = readBooleanFlag(flags, 'list')
  const all = readBooleanFlag(flags, 'all')
  const unattached = readBooleanFlag(flags, 'unattached')
  const allDevices = readBooleanFlag(flags, 'all-devices')
  const noReconnect = readBooleanFlag(flags, 'no-reconnect')
  const noLoginRelay = readBooleanFlag(flags, 'no-login-relay')
  const dryRun = readBooleanFlag(flags, 'dry-run')
  const name = readValueFlag(flags, 'name', '--name requires a value.')
  const kill = readValueFlag(flags, 'kill', '--kill requires a session name.')
  const cwd = readValueFlag(flags, 'cwd', '--cwd requires a remote directory.')
  const worktree = readValueFlag(flags, 'worktree', '--worktree requires a selector.')
  const run = readValueFlag(flags, 'run', '--run requires a command.')

  if (run !== undefined) {
    if (positionalArgs[0] !== 'new') {throw new CliArgumentError("--run is only supported with 'devbox shell new'.")}
    assertDevboxShellRunCommand(run)
  }

  if (name !== undefined && kill !== undefined) {
    throw new CliArgumentError('devbox shell --kill cannot be combined with --name.')
  }
  if (list && (name !== undefined || kill !== undefined || all || unattached || cwd !== undefined || noReconnect || noLoginRelay || dryRun || worktree !== undefined)) {
    throw new CliArgumentError('devbox shell --list cannot be combined with --name, --kill, --all, --unattached, --cwd, or reconnect flags.')
  }
  if (unattached && (name !== undefined || kill !== undefined || all || cwd !== undefined || noReconnect || noLoginRelay || dryRun || worktree !== undefined)) {
    throw new CliArgumentError('devbox shell --unattached cannot be combined with --name, --kill, --all, --cwd, or reconnect flags.')
  }

  const [verb, ...rest] = positionalArgs
  if (verb === undefined) {
    if (dryRun || worktree !== undefined) {throw new CliArgumentError('--dry-run and --worktree require `devbox shell reconnect --all`.')}
    if (list) {return { verb: 'list' }}
    if (allDevices) {throw new CliArgumentError('Usage: devbox shell rm --unattached --all-devices')}
    if (kill !== undefined) {return { verb: 'remove', target: kill, all: false, allDevices: false }}
    if (all) {return { verb: 'remove', all: true, allDevices: false }}
    if (unattached) {throw new CliArgumentError('Usage: devbox shell rm --unattached')}
    if (name !== undefined) {
      if (cwd !== undefined) {throw new CliArgumentError("--cwd is only supported with 'devbox shell new'.")}
      return { verb: 'attach', target: name, noReconnect, noLoginRelay }
    }
    if (cwd !== undefined) {throw new CliArgumentError("--cwd is only supported with 'devbox shell new'.")}
    return { verb: 'attach', noReconnect, noLoginRelay }
  }

  if (list || name !== undefined || kill !== undefined || (cwd !== undefined && verb !== 'new') || (unattached && verb !== 'rm')) {
    throw new CliArgumentError('Shell flags --list, --name, --kill, --cwd, and --unattached are only supported without a shell verb, except --unattached on rm.')
  }

  switch (verb) {
    case 'resume':
      if (rest.length > 0 || all || dryRun || worktree !== undefined) {throw new CliArgumentError(`${SHELL_USAGE}`)}
      return { verb: 'resume', noReconnect, noLoginRelay }
    case 'reconnect':
      if (rest.length > 0) {throw new CliArgumentError(`${SHELL_USAGE}`)}
      if (all) {
        if (noReconnect || noLoginRelay) {throw new CliArgumentError('--no-reconnect and --no-login-relay are not supported with reconnect --all.')}
        return { verb: 'reconnect-all', dryRun, ...(worktree === undefined ? {} : { worktree }) }
      }
      if (dryRun || worktree !== undefined) {throw new CliArgumentError('--dry-run and --worktree require `devbox shell reconnect --all`.')}
      return { verb: 'resume', noReconnect, noLoginRelay }
    case 'ls':
      if (rest.length > 0 || all || noReconnect || noLoginRelay || dryRun || worktree !== undefined) {throw new CliArgumentError('Usage: devbox shell ls [--json]')}
      return { verb: 'list' }
    case 'new':
      if (rest.length > 1 || all || dryRun || worktree !== undefined) {throw new CliArgumentError('Usage: devbox shell new [name] [--cwd <remote-dir>] [--run <command>] [--no-reconnect]')}
      return { verb: 'new', ...(rest[0] === undefined ? {} : { name: rest[0] }), ...(cwd === undefined ? {} : { cwd }), ...(run === undefined ? {} : { run }), noReconnect, noLoginRelay }
    case 'rm':
      if (rest.length > 1 || (all && rest.length > 0) || (unattached && rest.length > 0) || (all && unattached) || (allDevices && (!unattached || rest.length > 0)) || noReconnect || noLoginRelay || dryRun || worktree !== undefined) {
        throw new CliArgumentError('Usage: devbox shell rm <id-or-name> | --all | --unattached [--all-devices] | this')
      }
      if (all) {return { verb: 'remove', all: true, allDevices: false }}
      if (unattached) {return { verb: 'remove', all: false, unattached: true, allDevices }}
      if (rest[0] === undefined) {throw new CliArgumentError('Usage: devbox shell rm <id-or-name> | --all | --unattached [--all-devices] | this')}
      return { verb: 'remove', target: rest[0], all: false, allDevices: false }
    default:
      if (rest.length > 0 || all || dryRun || worktree !== undefined) {throw new CliArgumentError(SHELL_USAGE)}
      return { verb: 'attach', target: verb, noReconnect, noLoginRelay }
  }
}

/** Longest `--run` command accepted, in UTF-8 bytes; it is typed into a shell as one line. */
export const DEVBOX_SHELL_RUN_MAX_BYTES = 4096

/** `--run` is typed into the fresh login shell as a single line, so it must be one non-empty line. */
export function assertDevboxShellRunCommand(command: string): void {
  if (command.trim().length === 0) {throw new CliArgumentError('--run requires a command.')}
  if (command.includes('\0')) {throw new CliArgumentError('--run must not contain a NUL byte.')}
  if (/[\r\n]/u.test(command)) {throw new CliArgumentError('--run must be a single line (no newline or carriage return).')}
  if (Buffer.byteLength(command, 'utf8') > DEVBOX_SHELL_RUN_MAX_BYTES) {
    throw new CliArgumentError(`--run must be at most ${DEVBOX_SHELL_RUN_MAX_BYTES} bytes.`)
  }
}

function readBooleanFlag(flags: ReadonlyMap<string, FlagValue>, name: string): boolean {
  const value = flags.get(name)
  if (value === undefined) {return false}
  if (value !== true) {throw new CliArgumentError(`--${name} does not take a value.`)}
  return true
}

function readValueFlag(
  flags: ReadonlyMap<string, FlagValue>,
  name: string,
  missingMessage: string
): string | undefined {
  const value = flags.get(name)
  if (value === undefined) {return undefined}
  if (typeof value !== 'string' || value.length === 0) {throw new CliArgumentError(missingMessage)}
  return value
}
