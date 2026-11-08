import { RESET } from './presentation-ansi'
import type { WrapTextOptions } from './presentation-types'
import { graphemeWidth, textTokens, visibleWidth, type TextToken } from './presentation-width'

/**
 * Wrap text at terminal-cell boundaries without truncating its content.
 *
 * ANSI control sequences are zero-width and are carried across wrapped lines
 * so a styled value remains styled after a word or hard break. Grapheme
 * clusters are kept intact; a single wide grapheme may therefore exceed a
 * one-cell limit because splitting it would corrupt the character.
 */
export function wrapText(
  value: string,
  maxWidth: number,
  options: WrapTextOptions = {}
): string[] {
  const limit = Math.max(1, Math.floor(maxWidth))
  const preserveIndent = options.preserveIndent !== false
  return value.replace(/\r\n?/gu, '\n').split('\n').flatMap((line) => {
    if (visibleWidth(line) <= limit) {
      return [line]
    }

    const indent = preserveIndent
      ? line.match(/^\s*/u)?.[0] ?? ''
      : ''
    const indentWidth = visibleWidth(indent)
    const safeIndent = indentWidth < limit ? indent : ''
    const content = safeIndent.length > 0 ? line.slice(safeIndent.length) : line
    const contentWidth = Math.max(1, limit - visibleWidth(safeIndent))
    return wrapTokenLine(content, contentWidth).map((part) => `${safeIndent}${part}`)
  })
}

/** Alias for callers that make the ANSI-safety of wrapping explicit. */
export const wrapAnsi = wrapText

function wrapTokenLine(value: string, limit: number): string[] {
  const tokens = textTokens(value)
  const lines: string[] = []
  let start = 0

  while (start < tokens.length) {
    let width = 0
    let cursor = start
    let lastBreak = -1

    while (cursor < tokens.length) {
      const token = tokens[cursor]!
      if (!token.ansi) {
        const tokenWidth = token.text === '\t' ? 4 : graphemeWidth(token.text)
        if (isWhitespaceToken(token.text)) {
          if (width + tokenWidth > limit) {
            break
          }
          width += tokenWidth
          lastBreak = cursor + 1
        } else if (width + tokenWidth > limit) {
          break
        } else {
          width += tokenWidth
        }
      }
      cursor += 1
    }

    if (cursor === tokens.length) {
      lines.push(renderWrappedSegment(tokens, start, cursor))
      break
    }

    if (lastBreak > start) {
      lines.push(renderWrappedSegment(tokens, start, trimTrailingWhitespace(tokens, lastBreak)))
      start = lastBreak
      while (start < tokens.length && isWhitespaceToken(tokens[start]!.text)) {
        start += 1
      }
      continue
    }

    // There is no whitespace to use as a break, so split at the next
    // grapheme boundary. A wide grapheme is kept whole even at width one.
    const end = cursor > start ? cursor : cursor + 1
    lines.push(renderWrappedSegment(tokens, start, end))
    start = end
  }

  return lines.length > 0 ? lines : ['']
}

function renderWrappedSegment(
  tokens: readonly TextToken[],
  start: number,
  end: number
): string {
  const prefix = ansiStyleState(tokens, start).join('')
  const body = tokens.slice(start, end).map((token) => token.text).join('')
  const suffix = ansiStyleState(tokens, end).length > 0 ? RESET : ''
  return `${prefix}${body}${suffix}`
}

function ansiStyleState(tokens: readonly TextToken[], end: number): string[] {
  const state: string[] = []
  for (const token of tokens.slice(0, end)) {
    if (!token.ansi || !isSgrSequence(token.text)) {
      continue
    }
    if (isSgrReset(token.text)) {
      state.length = 0
    } else {
      state.push(token.text)
    }
  }
  return state
}

function isSgrSequence(value: string): boolean {
  return (value.startsWith('\u001b[') || value.startsWith('\u009b'))
    && value.endsWith('m')
}

function isSgrReset(value: string): boolean {
  return value === '\u001b[0m' || value === '\u001b[39m' || value === '\u001b[49m'
    || value === '\u009b0m' || value === '\u009b39m' || value === '\u009b49m'
}

function trimTrailingWhitespace(tokens: readonly TextToken[], end: number): number {
  let result = end
  while (result > 0) {
    const token = tokens[result - 1]!
    if (token.ansi || !isWhitespaceToken(token.text)) {
      break
    }
    result -= 1
  }
  return result
}

function isWhitespaceToken(value: string): boolean {
  return /^\s$/u.test(value)
}
