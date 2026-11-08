import { describe, expect, it } from 'vitest'
import { shellEscape } from './shell-escape'

describe('shellEscape', () => {
  it.each([
    ['', "''"],
    ['plain', "'plain'"],
    ['space separated', "'space separated'"],
    ["apostrophe's", "'apostrophe'\\''s'"],
    ['line\nfeed', "'line\nfeed'"],
    ['dollar $HOME and `command`', "'dollar $HOME and `command`'"],
    ['back\\slash', "'back\\slash'"],
    ['\0', "'\0'"],
    ['emoji 🛰️', "'emoji 🛰️'"]
  ])('quotes %j as %j', (input, expected) => {
    expect(shellEscape(input)).toBe(expected)
  })
})
