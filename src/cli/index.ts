#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { findCommandSpec, parseArgs, resolveHelpPath, validateCommandAndFlags, type CommandSpec } from './args'
import { DEVBOX_HANDLERS, type HandlerContext } from './handlers'
import { devboxExitCode, printDevboxError } from './format'
import { DevboxService } from './operations'
import { resolveCommandProfile } from './profile-scope'
import { normalizeProfileSelectionFlags } from './profile-resolution'
import { COMMAND_SPECS } from './specs'
import { createPresentation, truncateText, visibleWidth, wrapText, type Presentation, type PresentationOptions } from './presentation'
import { DEVBOX_VERSION } from './version'

export { COMMAND_SPECS }
export { DEVBOX_VERSION }

export type ServiceFactory = () => DevboxService
export type MainOptions = {
  exitGuard?: (code: number) => void
  presentation?: PresentationOptions
}

const defaultServiceFactory: ServiceFactory = () => new DevboxService()

export function scheduleExitGuard(
  code: number,
  exit: (code: number) => never = process.exit
): void {
  const timer = setTimeout(() => exit(code), 250)
  timer.unref()
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  makeService: ServiceFactory = defaultServiceFactory,
  options: MainOptions = {}
): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    process.stdout.write(`devbox ${DEVBOX_VERSION} (previously devbox 0.1.8)\n`)
    return
  }
  const parsed = parseArgs(argv)
  const helpPath = resolveHelpPath(parsed)
  const presentationOptions = options.presentation ?? { output: process.stdout, env: process.env }
  if (helpPath !== null) {
    printHelp(helpPath, console.log, presentationOptions)
    return
  }
  if (parsed.commandPath.length === 0) {
    printHelp([], console.log, presentationOptions)
    return
  }
  if (!findCommandSpec(COMMAND_SPECS, parsed.commandPath)) {
    console.error(`Unknown command: ${parsed.commandPath.join(' ')}`)
    printHelp([], console.error, presentationOptions)
    process.exitCode = 2
    return
  }
  const json = parsed.flags.get('json') === true
  try {
    normalizeProfileSelectionFlags(parsed.flags)
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    const handler = DEVBOX_HANDLERS[parsed.commandPath.join(' ')]
    if (!handler) {throw new Error(`Unknown command: ${parsed.commandPath.join(' ')}`)}
    const service = makeService()
    try {
      const selection = resolveCommandProfile(parsed.commandPath, parsed.flags, process.env, parsed.positionalArgs)
      if (selection) {
        parsed.flags.set('profile', selection.profileId)
      }
      const context: HandlerContext = {
        flags: parsed.flags,
        service,
        cwd,
        json,
        profile: selection?.profile,
        profileSelection: selection,
        positionalArgs: parsed.positionalArgs,
        rawArgs: parsed.passthroughArgs,
        holdForeground: parsed.commandPath.join(' ') === 'ports open' ? waitForTerminationSignal : undefined
      }
      await handler(context)
    } catch (error) {
      printDevboxError(parsed.commandPath.join(' '), error, json)
      process.exitCode = devboxExitCode(error)
    } finally {
      try {
        await service.dispose?.()
      } catch (error) {
        printDevboxError(parsed.commandPath.join(' '), error, json)
        process.exitCode = devboxExitCode(error)
      }
      process.exitCode ??= 0
      const code = typeof process.exitCode === 'number' ? process.exitCode : 0
      const exitGuard = options.exitGuard ?? (makeService === defaultServiceFactory ? scheduleExitGuard : undefined)
      exitGuard?.(code)
    }
  } catch (error) {
    printDevboxError(parsed.commandPath.join(' '), error, json)
    process.exitCode = devboxExitCode(error)
  }
}

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.removeListener('SIGINT', finish)
      process.removeListener('SIGTERM', finish)
      process.exitCode = 0
      resolve()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })
}

const EVERYDAY_COMMANDS = [
  'devbox status',
  'devbox init --host <h> --user <u> --local-root <abs> --yes',
  'devbox mutagen status',
  'devbox pair',
  'devbox sync                       # every machine now, live view',
  "devbox run -- /bin/sh -c 'echo hello'",
  'devbox device --default <alias>   # then shell/run/mutagen use that device',
  'devbox shell',
  'devbox shell resume',
  'devbox jobs log --job-id <id>',
  'devbox ports open --remote-port 8080'
] as const

const STACKED_COMMANDS_WIDTH = 96

function printHelp(
  path: readonly string[],
  write: (line: string) => void = console.log,
  options: PresentationOptions = { output: process.stdout, env: process.env }
): void {
  const presentation = createPresentation(options)
  const spec = findCommandSpec(COMMAND_SPECS, path)
  const group = path.length > 0
    ? COMMAND_SPECS.filter((candidate) => candidate.path.length > path.length && candidate.path.slice(0, path.length).every((part, index) => part === path[index]))
    : []
  write(spec
    ? renderCommandHelp(spec, presentation)
    : group.length > 0
      ? renderGroupHelp(path, group, presentation)
      : renderGenericHelp(presentation))
}

function renderGenericHelp(presentation: Presentation): string {
  const lines = [
    fitHelpLine(presentation.title('Devbox standalone CLI'), presentation.width),
    '',
    fitHelpLine(labelledHelpLine('Usage', 'devbox <command> [flags]', presentation), presentation.width),
    '',
    fitHelpLine(presentation.section('Everyday commands (single profile: no --profile needed):'), presentation.width),
    ...EVERYDAY_COMMANDS.map((command) => fitHelpLine(`  ${presentation.style(command, 'accent')}`, presentation.width)),
    '',
    fitHelpLine(presentation.section('Commands'), presentation.width),
    renderCommandListing(COMMAND_SPECS, presentation),
    '',
    fitHelpLine(labelledHelpLine('Global flags', '--help --json --version --device <name>', presentation), presentation.width),
    fitHelpLine(presentation.style('First-time setup (local + remote): AGENT-SETUP.md in the repo · devbox help init · devbox help connect', 'muted'), presentation.width)
  ]
  return lines.join('\n')
}

function renderCommandHelp(spec: CommandSpec, presentation: Presentation): string {
  const lines = [
    fitHelpLine(presentation.title(`devbox ${spec.path.join(' ')}`), presentation.width),
    '',
    ...labelledHelpLines('Summary', spec.summary, presentation),
    ...labelledHelpLines('Usage', spec.usage, presentation, 'accent')
  ]
  if (spec.notes && spec.notes.length > 0) {
    lines.push('', fitHelpLine(presentation.section('Notes:'), presentation.width))
    lines.push(...spec.notes.flatMap((note) => wrapStyledHelpLines(`  ${note}`, presentation, 'muted')))
  }
  if (spec.examples && spec.examples.length > 0) {
    lines.push('', fitHelpLine(presentation.section('Examples:'), presentation.width))
    lines.push(...spec.examples.flatMap((example) => wrapStyledHelpLines(`  ${example}`, presentation, 'accent')))
  }
  return lines.join('\n')
}

function renderGroupHelp(
  path: readonly string[],
  specs: readonly CommandSpec[],
  presentation: Presentation
): string {
  const name = path.join(' ')
  const lines = [
    fitHelpLine(presentation.title(`Devbox ${name}`), presentation.width),
    '',
    fitHelpLine(labelledHelpLine('Usage', `devbox ${name} <command> [flags]`, presentation), presentation.width),
    '',
    fitHelpLine(presentation.section('Commands'), presentation.width),
    renderCommandListing(specs, presentation),
    '',
    fitHelpLine(labelledHelpLine('Global flags', '--help --json --version --device <name>', presentation), presentation.width)
  ]
  return lines.join('\n')
}

function renderCommandListing(specs: readonly CommandSpec[], presentation: Presentation): string {
  if (presentation.width < STACKED_COMMANDS_WIDTH) {
    return specs.map((spec) => {
      const command = wrapStyledHelpLines(
        `  devbox ${spec.path.join(' ')}`,
        presentation,
        'accent'
      )
      const summary = wrapStyledHelpLines(`    ${spec.summary}`, presentation, 'muted')
      return [...command, ...summary].join('\n')
    }).join('\n')
  }
  return presentation.table({
    rows: specs,
    columns: [
      {
        header: 'COMMAND',
        get: (spec) => `devbox ${spec.path.join(' ')}`,
        format: (value) => presentation.style(String(value), 'accent'),
        priority: 4,
        minWidth: 24
      },
      {
        header: 'SUMMARY',
        get: (spec) => spec.summary,
        format: (value) => presentation.style(String(value), 'muted'),
        priority: 2,
        minWidth: 18
      }
    ],
    gap: 2,
    headerStyle: 'section'
  })
}

function labelledHelpLine(
  label: string,
  value: string,
  presentation: Presentation,
  valueStyle?: 'accent' | 'muted'
): string {
  const styledValue = valueStyle ? presentation.style(value, valueStyle) : value
  return `${presentation.section(`${label}:`)} ${styledValue}`
}

function labelledHelpLines(
  label: string,
  value: string,
  presentation: Presentation,
  valueStyle?: 'accent' | 'muted'
): string[] {
  const prefix = `${label}: `
  const available = Math.max(1, presentation.width - visibleWidth(prefix))
  const valueLines = wrapPlainText(value, available)
  const continuation = ' '.repeat(visibleWidth(prefix))
  return valueLines.map((line, index) => {
    const labelText = index === 0 ? presentation.section(`${label}:`) : continuation
    const valueText = valueStyle ? presentation.style(line, valueStyle) : line
    return `${labelText}${index === 0 ? ' ' : ''}${valueText}`
  })
}

function wrapStyledHelpLines(
  line: string,
  presentation: Presentation,
  style: 'accent' | 'muted'
): string[] {
  return wrapPlainLine(line, presentation.width)
    .map((part) => presentation.style(part, style))
}

function wrapPlainText(value: string, width: number): string[] {
  return wrapText(value, width, { preserveIndent: false })
}

function wrapPlainLine(line: string, width: number): string[] {
  return wrapText(line, width)
}

function fitHelpLine(line: string, width: number): string {
  return truncateText(line, width, '...')
}

if (isMainModule()) {void main()}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false
  }
  try {
    return realpathSync(import.meta.filename) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}
