import type { PresentationOptions, SemanticStyle } from './presentation-types'

const ESC = '\u001b'
export const RESET = `${ESC}[0m`

export const ANSI_STYLES: Readonly<Record<SemanticStyle | 'reset', string>> = {
  reset: RESET,
  title: `${ESC}[1;36m`,
  section: `${ESC}[1m`,
  label: `${ESC}[2m`,
  value: '',
  muted: `${ESC}[2m`,
  info: `${ESC}[36m`,
  success: `${ESC}[32m`,
  warning: `${ESC}[33m`,
  error: `${ESC}[31m`,
  accent: `${ESC}[35m`
}

const DEFAULT_TERMINAL_WIDTH = 80

/** Return true when ANSI colour should be emitted for the supplied environment. */
export function colorEnabled(options: PresentationOptions = {}): boolean {
  if (options.color === 'always' || options.color === true) {
    return true
  }
  if (options.color === 'never' || options.color === false) {
    return false
  }

  const env = options.env ?? process.env
  const forced = forceColorValue(env.FORCE_COLOR)
  if (forced !== undefined) {
    return forced
  }
  if (Object.prototype.hasOwnProperty.call(env, 'NO_COLOR')) {
    return false
  }
  if (env.TERM?.toLowerCase() === 'dumb') {
    return false
  }

  return options.isTTY
    ?? options.output?.isTTY
    ?? (options.env === undefined && process.stdout.isTTY === true)
}

/** Alias that reads naturally at call sites which ask a yes/no question. */
export const shouldUseColor = colorEnabled

function forceColorValue(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  return normalized !== ''
    && normalized !== '0'
    && normalized !== 'false'
    && normalized !== 'no'
}

/** Return the best available terminal width, with all sources injectable. */
export function getTerminalWidth(options: PresentationOptions = {}): number {
  const candidates = [
    options.width,
    options.columns,
    options.output?.columns,
    ...(options.env === undefined ? [process.stdout.columns] : []),
    parsePositiveInteger((options.env ?? process.env).COLUMNS)
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.max(1, Math.floor(candidate))
    }
  }
  return DEFAULT_TERMINAL_WIDTH
}

/** Alias for callers that use the shorter terminal vocabulary. */
export const terminalWidth = getTerminalWidth

/** Apply one restrained semantic style, or return plain text when colour is off. */
export function styleText(
  text: string,
  style: SemanticStyle,
  options: PresentationOptions = {}
): string {
  if (text.length === 0 || !colorEnabled(options)) {
    return text
  }
  const code = ANSI_STYLES[style]
  return code.length === 0 ? text : `${code}${text}${RESET}`
}

export const applyStyle = styleText

/** Return whether the environment can safely display the Unicode symbols we use. */
export function unicodeEnabled(options: PresentationOptions = {}): boolean {
  if (options.unicode !== undefined) {
    return options.unicode
  }
  const env = options.env ?? process.env
  if (env.TERM?.toLowerCase() === 'dumb') {
    return false
  }
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG
  return locale === undefined || /utf-?8/iu.test(locale)
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value.trim())) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
