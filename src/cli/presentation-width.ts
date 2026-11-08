import { RESET } from './presentation-ansi'
const ESC = '\u001b'

export type TextToken = {
  readonly text: string
  readonly ansi: boolean
}

/** Remove terminal control sequences while leaving the printable text intact. */
export function stripAnsi(value: string): string {
  let result = ''
  let index = 0
  while (index < value.length) {
    const end = ansiSequenceEnd(value, index)
    if (end !== undefined) {
      index = end
      continue
    }
    const codePoint = value.codePointAt(index) ?? 0
    const character = String.fromCodePoint(codePoint)
    result += character
    index += character.length
  }
  return result
}

/**
 * Approximate terminal cell width. It handles ANSI, combining marks, emoji
 * sequences, regional-indicator flags, tabs, and common East Asian ranges.
 */
export function visibleWidth(value: string, tabSize = 4): number {
  let width = 0
  for (const token of textTokens(value)) {
    if (token.ansi) {
      continue
    }
    width += token.text === '\t'
      ? Math.max(1, tabSize)
      : graphemeWidth(token.text)
  }
  return width
}

/** Truncate without splitting a grapheme cluster or an ANSI escape sequence. */
export function truncateText(value: string, maxWidth: number, ellipsis = '…'): string {
  const limit = Math.max(0, Math.floor(maxWidth))
  if (limit === 0) {
    return ''
  }
  if (visibleWidth(value) <= limit) {
    return value
  }

  const suffix = visibleWidth(ellipsis) > limit
    ? visiblePrefix(ellipsis, limit)
    : ellipsis
  const suffixWidth = visibleWidth(suffix)
  const budget = Math.max(0, limit - suffixWidth)
  let result = ''
  let width = 0
  let hasAnsi = false

  for (const token of textTokens(value)) {
    if (token.ansi) {
      hasAnsi = true
      result += token.text
      continue
    }
    const tokenWidth = graphemeWidth(token.text)
    if (width + tokenWidth > budget) {
      break
    }
    result += token.text
    width += tokenWidth
  }

  result += suffix
  // A truncated styled value must not colour the next CLI line.
  return hasAnsi ? `${result}${RESET}` : result
}

export const truncateAnsi = truncateText

/** Pad or truncate text using display cells rather than JavaScript length. */
export function padText(
  value: string,
  width: number,
  alignment: 'left' | 'center' | 'right' = 'left'
): string {
  const limit = Math.max(0, Math.floor(width))
  const text = truncateText(value, limit)
  const missing = Math.max(0, limit - visibleWidth(text))

  switch (alignment) {
    case 'right':
      return ' '.repeat(missing) + text
    case 'center': {
      const left = Math.floor(missing / 2)
      return ' '.repeat(left) + text + ' '.repeat(missing - left)
    }
    case 'left':
      return text + ' '.repeat(missing)
  }
}

export const padAnsi = padText

export function textTokens(value: string): TextToken[] {
  const tokens: TextToken[] = []
  let index = 0
  while (index < value.length) {
    const end = ansiSequenceEnd(value, index)
    if (end !== undefined) {
      tokens.push({ text: value.slice(index, end), ansi: true })
      index = end
      continue
    }
    const grapheme = nextGrapheme(value, index)
    tokens.push({ text: grapheme.text, ansi: false })
    index = grapheme.end
  }
  return tokens
}

function ansiSequenceEnd(value: string, start: number): number | undefined {
  const first = value[start]
  if (first !== ESC && first !== '\u009b') {
    return undefined
  }
  if (first === '\u009b') {
    return controlSequenceEnd(value, start + 1)
  }
  if (start + 1 >= value.length) {
    return value.length
  }
  const introducer = value[start + 1]
  if (introducer === '[') {
    return controlSequenceEnd(value, start + 2)
  }
  if (introducer === ']' || introducer === 'P' || introducer === '^'
    || introducer === '_' || introducer === 'X') {
    for (let index = start + 2; index < value.length; index += 1) {
      if (value[index] === '\u0007') {
        return index + 1
      }
      if (value[index] === ESC && value[index + 1] === '\\') {
        return index + 2
      }
    }
    return value.length
  }
  return start + 2
}

function controlSequenceEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) {
      return index + 1
    }
  }
  return value.length
}

function nextGrapheme(
  value: string,
  start: number
): { readonly text: string; readonly end: number } {
  const firstCodePoint = value.codePointAt(start) ?? 0
  const first = String.fromCodePoint(firstCodePoint)
  let end = start + first.length
  let text = first

  if (isRegionalIndicator(firstCodePoint)) {
    const nextCodePoint = value.codePointAt(end)
    if (nextCodePoint !== undefined && isRegionalIndicator(nextCodePoint)) {
      const next = String.fromCodePoint(nextCodePoint)
      text += next
      end += next.length
    }
  }

  while (end < value.length) {
    const codePoint = value.codePointAt(end) ?? 0
    const character = String.fromCodePoint(codePoint)
    if (isCombining(codePoint) || isVariationSelector(codePoint)
      || isEmojiModifier(codePoint) || codePoint === 0x20e3) {
      text += character
      end += character.length
      continue
    }
    if (codePoint === 0x200d) {
      text += character
      end += character.length
      if (end < value.length) {
        const joinedCodePoint = value.codePointAt(end) ?? 0
        const joined = String.fromCodePoint(joinedCodePoint)
        text += joined
        end += joined.length
      }
      continue
    }
    break
  }
  return { text, end }
}

export function graphemeWidth(value: string): number {
  let hasVisibleCharacter = false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isControl(codePoint) || isCombining(codePoint)
      || isVariationSelector(codePoint) || isEmojiModifier(codePoint)
      || codePoint === 0x200d) {
      continue
    }
    hasVisibleCharacter = true
    if (isWide(codePoint) || isEmoji(codePoint)) {
      return 2
    }
  }
  return hasVisibleCharacter ? 1 : 0
}

function visiblePrefix(value: string, limit: number): string {
  let result = ''
  let width = 0
  for (const token of textTokens(value)) {
    if (token.ansi) {
      result += token.text
      continue
    }
    const tokenWidth = graphemeWidth(token.text)
    if (width + tokenWidth > limit) {
      break
    }
    result += token.text
    width += tokenWidth
  }
  return result
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function isCombining(codePoint: number): boolean {
  return /\p{Mark}/u.test(String.fromCodePoint(codePoint))
}

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff
}

function isEmoji(codePoint: number): boolean {
  return (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0x3247)
    || (codePoint >= 0x3250 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0xa4c6)
    || (codePoint >= 0xa960 && codePoint <= 0xa97c)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6b)
    || (codePoint >= 0xff01 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}
