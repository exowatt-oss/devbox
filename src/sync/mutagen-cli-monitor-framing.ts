function isWhitespace(character: string): boolean {
  return /\s/u.test(character)
}

function matchingCloser(opener: string): string {
  return opener === '[' ? ']' : '}'
}

export function splitMutagenMonitorFrames(output: string): readonly string[] {
  const frames: string[] = []
  const stack: string[] = []
  let frameStart = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]
    if (frameStart < 0) {
      if (isWhitespace(character)) {
        continue
      }
      if (character !== '[' && character !== '{') {
        throw new Error('Mutagen monitor output contains data outside a JSON frame')
      }
      frameStart = index
      stack.push(character)
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character === '[' || character === '{') {
      stack.push(character)
      continue
    }
    if (character !== ']' && character !== '}') {
      continue
    }

    const opener = stack.pop()
    if (!opener || matchingCloser(opener) !== character) {
      throw new Error('Mutagen monitor output contains unbalanced JSON frames')
    }
    if (stack.length === 0) {
      frames.push(output.slice(frameStart, index + 1))
      frameStart = -1
    }
  }

  if (frameStart >= 0 || inString || stack.length > 0) {
    throw new Error('Mutagen monitor output contains an incomplete JSON frame')
  }
  if (frames.length === 0) {
    throw new Error('Mutagen monitor output contains no JSON frames')
  }
  return Object.freeze(frames)
}
