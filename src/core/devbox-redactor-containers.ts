import { redactedDevboxValue, type DevboxRedactionBoundary } from '../shared/devbox-errors'
import type { DevboxRedactionLimits } from './devbox-redactor-contract'
import { ARGV_SECRET_FLAG_PATTERN, CIRCULAR_TEXT, isSensitiveKey } from './devbox-redactor-patterns'
import { redactArgValue, redactStringValue } from './devbox-redactor-strings'

type RedactionState = {
  readonly limits: DevboxRedactionLimits
  readonly seen: WeakSet<object>
  nodes: number
}

function consumeNode(state: RedactionState): boolean {
  if (state.nodes >= state.limits.maxNodes) {
    return false
  }
  state.nodes += 1
  return true
}

function isError(value: object): value is Error {
  return value instanceof Error
}

function defineErrorProperty(error: Error, key: 'message' | 'stack', value: string): void {
  Object.defineProperty(error, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value
  })
}

function redactError(
  value: Error,
  state: RedactionState,
  depth: number
): Error | DevboxRedactionBoundary | typeof CIRCULAR_TEXT {
  if (state.seen.has(value)) {
    return CIRCULAR_TEXT
  }
  if (!consumeNode(state) || depth > state.limits.maxDepth) {
    return redactedDevboxValue()
  }
  state.seen.add(value)

  const message = redactStringValue(value.message, state.limits.maxStringLength)
  const safeMessage = typeof message === 'string' ? message : message.value
  const error = new Error(safeMessage)
  Object.setPrototypeOf(error, Object.getPrototypeOf(value))

  const name = redactStringValue(value.name, state.limits.maxStringLength)
  error.name = typeof name === 'string' ? name : name.value
  if (value.stack !== undefined) {
    const stack = redactStringValue(value.stack, state.limits.maxStringLength)
    defineErrorProperty(error, 'stack', typeof stack === 'string' ? stack : stack.value)
  }

  for (const key of Object.keys(value)) {
    if (key === 'message' || key === 'name' || key === 'stack') {
      continue
    }
    ;(error as unknown as Record<string, unknown>)[key] = isSensitiveKey(key)
      ? redactedDevboxValue()
      : redactNode((value as unknown as Record<string, unknown>)[key], state, depth + 1)
  }
  return error
}

function redactArray(
  value: readonly unknown[],
  state: RedactionState,
  depth: number
): unknown[] | DevboxRedactionBoundary | typeof CIRCULAR_TEXT {
  if (state.seen.has(value)) {
    return CIRCULAR_TEXT
  }
  if (!consumeNode(state) || depth > state.limits.maxDepth) {
    return redactedDevboxValue()
  }
  state.seen.add(value)

  const output: unknown[] = []
  let expectsSecret = false
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      if (!consumeNode(state)) {
        output.push(redactedDevboxValue())
        break
      }
      output.length = index + 1
      expectsSecret = false
      continue
    }
    if (state.nodes >= state.limits.maxNodes) {
      output.push(redactedDevboxValue())
      break
    }
    const entry = value[index]
    if (typeof entry === 'string') {
      if (!consumeNode(state)) {
        output.push(redactedDevboxValue())
        break
      }
      output.push(redactArgValue(entry, expectsSecret, state.limits.maxStringLength))
      expectsSecret = ARGV_SECRET_FLAG_PATTERN.test(entry) && !entry.includes('=')
      continue
    }
    output.push(redactNode(entry, state, depth + 1))
    expectsSecret = false
  }
  return output
}

function redactMap(
  value: Map<unknown, unknown>,
  state: RedactionState,
  depth: number
): Map<unknown, unknown> | DevboxRedactionBoundary | typeof CIRCULAR_TEXT {
  if (state.seen.has(value)) {
    return CIRCULAR_TEXT
  }
  if (!consumeNode(state) || depth > state.limits.maxDepth) {
    return redactedDevboxValue()
  }
  state.seen.add(value)

  const output = new Map<unknown, unknown>()
  for (const [key, entry] of value) {
    if (state.nodes >= state.limits.maxNodes) {
      output.set(redactedDevboxValue(), redactedDevboxValue())
      break
    }
    const sensitiveKey = typeof key === 'string' && isSensitiveKey(key)
    if (sensitiveKey && !consumeNode(state)) {
      output.set(redactedDevboxValue(), redactedDevboxValue())
      break
    }
    const safeKey = sensitiveKey ? redactedDevboxValue() : redactNode(key, state, depth + 1)
    const safeValue = sensitiveKey ? redactedDevboxValue() : redactNode(entry, state, depth + 1)
    output.set(safeKey, safeValue)
  }
  return output
}

function redactSet(
  value: Set<unknown>,
  state: RedactionState,
  depth: number
): Set<unknown> | DevboxRedactionBoundary | typeof CIRCULAR_TEXT {
  if (state.seen.has(value)) {
    return CIRCULAR_TEXT
  }
  if (!consumeNode(state) || depth > state.limits.maxDepth) {
    return redactedDevboxValue()
  }
  state.seen.add(value)

  const output = new Set<unknown>()
  for (const entry of value) {
    if (state.nodes >= state.limits.maxNodes) {
      output.add(redactedDevboxValue())
      break
    }
    output.add(redactNode(entry, state, depth + 1))
  }
  return output
}

function redactObject(
  value: Record<string, unknown>,
  state: RedactionState,
  depth: number
): Record<string, unknown> | DevboxRedactionBoundary | typeof CIRCULAR_TEXT {
  if (state.seen.has(value)) {
    return CIRCULAR_TEXT
  }
  if (!consumeNode(state) || depth > state.limits.maxDepth) {
    return redactedDevboxValue()
  }
  state.seen.add(value)

  const output: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(value) === null ? null : Object.prototype
  )
  for (const key of Object.keys(value)) {
    if (state.nodes >= state.limits.maxNodes) {
      output.__devboxRedactionLimit = redactedDevboxValue()
      break
    }
    if (isSensitiveKey(key)) {
      if (!consumeNode(state)) {
        output.__devboxRedactionLimit = redactedDevboxValue()
        break
      }
      output[key] = redactedDevboxValue()
    } else {
      output[key] = redactNode(value[key], state, depth + 1)
    }
  }
  return output
}

function redactNode(value: unknown, state: RedactionState, depth: number): unknown {
  if (value === null || value === undefined) {
    if (!consumeNode(state) || depth > state.limits.maxDepth) {
      return redactedDevboxValue()
    }
    return value
  }
  if (typeof value === 'string') {
    if (!consumeNode(state) || depth > state.limits.maxDepth) {
      return redactedDevboxValue()
    }
    return redactStringValue(value, state.limits.maxStringLength)
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    if (!consumeNode(state) || depth > state.limits.maxDepth) {
      return redactedDevboxValue()
    }
    return value
  }
  if (!isObject(value)) {
    return value
  }
  if (isError(value)) {
    return redactError(value, state, depth)
  }
  if (Array.isArray(value)) {
    return redactArray(value, state, depth)
  }
  if (value instanceof Map) {
    return redactMap(value, state, depth)
  }
  if (value instanceof Set) {
    return redactSet(value, state, depth)
  }
  if (value instanceof Date) {
    if (!consumeNode(state) || depth > state.limits.maxDepth) {
      return redactedDevboxValue()
    }
    return new Date(value.getTime())
  }
  if (value instanceof RegExp) {
    if (!consumeNode(state) || depth > state.limits.maxDepth) {
      return redactedDevboxValue()
    }
    return new RegExp(value.source, value.flags)
  }
  return redactObject(value as Record<string, unknown>, state, depth)
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

export function redactDevboxNode(value: unknown, limits: DevboxRedactionLimits): unknown {
  const state: RedactionState = { limits, seen: new WeakSet(), nodes: 0 }
  return redactNode(value, state, 0)
}
