import { createHash } from 'node:crypto'

export function operationKey(operation: string, args: unknown, explicit?: string): string {
  const value = explicit ? { operation, explicitOperationKey: explicit } : { operation, args }
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 32)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
