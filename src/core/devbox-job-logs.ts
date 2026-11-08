import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { registerDevboxJobLogPath } from './devbox-job-logs-diagnostics'

export type DevboxJobLogStoreOptions = {
  rootDir: string
  perJobBytes?: number
  globalBytes?: number
}

export type DevboxJobLogAppendResult = {
  acceptedBytes: number
  droppedBytes: number
  droppedMarker: string | null
}

export type DevboxJobLogTail = {
  jobId: string
  offset: number
  nextOffset: number
  text: string
  droppedMarkers: readonly string[]
  sensitive: true
  includeInDiagnostics: false
}

const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function marker(jobId: string, dropped: number, reason: string): string {
  return `[devbox dropped ${dropped} bytes for ${jobId}: ${reason}]\n`
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  const buffer = Buffer.from(value, 'utf8')
  let end = Math.min(maxBytes, buffer.length)
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end--
  }
  return buffer.subarray(0, end).toString('utf8')
}

function fitRotatedPayload(
  jobId: string,
  input: string,
  inputBytes: number,
  availableBytes: number,
  reason: string
): { payload: string; acceptedBytes: number; droppedBytes: number } {
  if (inputBytes <= availableBytes) {
    return { payload: input, acceptedBytes: inputBytes, droppedBytes: 0 }
  }

  // Marker length depends on the decimal dropped count. Start with the shortest
  // marker and converge upward; marker size only grows as the count grows.
  let dropped = 0
  for (let attempt = 0; attempt < 32; attempt++) {
    const droppedMarker = marker(jobId, dropped, reason)
    if (bytes(droppedMarker) > availableBytes) {
      return { payload: '', acceptedBytes: 0, droppedBytes: inputBytes }
    }
    const prefix = truncateUtf8(input, availableBytes - bytes(droppedMarker))
    const acceptedBytes = bytes(prefix)
    const nextDropped = inputBytes - acceptedBytes
    if (nextDropped === dropped) {
      return {
        payload: `${prefix}${marker(jobId, nextDropped, reason)}`,
        acceptedBytes,
        droppedBytes: nextDropped
      }
    }
    dropped = nextDropped
  }

  // The decimal marker has only a handful of possible lengths. This fallback
  // still calculates the final marker and clamps the prefix before writing.
  const finalMarker = marker(jobId, dropped, reason)
  if (bytes(finalMarker) > availableBytes) {
    return { payload: '', acceptedBytes: 0, droppedBytes: inputBytes }
  }
  const prefix = truncateUtf8(input, availableBytes - bytes(finalMarker))
  const acceptedBytes = bytes(prefix)
  const finalDropped = inputBytes - acceptedBytes
  const finalPayload = `${prefix}${marker(jobId, finalDropped, reason)}`
  if (bytes(finalPayload) > availableBytes) {
    return { payload: '', acceptedBytes: 0, droppedBytes: inputBytes }
  }
  return {
    payload: finalPayload,
    acceptedBytes,
    droppedBytes: finalDropped
  }
}

export class DevboxJobLogStore {
  private readonly rootDir: string
  private readonly perJobBytes: number
  private readonly globalBytes: number
  private readonly markers = new Map<string, string[]>()

  constructor(options: DevboxJobLogStoreOptions) {
    this.rootDir = options.rootDir
    this.perJobBytes = options.perJobBytes ?? 4 * 1024 * 1024
    this.globalBytes = options.globalBytes ?? 64 * 1024 * 1024
    if (this.perJobBytes <= 0 || this.globalBytes < this.perJobBytes) {
      throw new RangeError('Devbox workload log quotas are invalid.')
    }
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 })
    chmodSync(this.rootDir, 0o700)
  }

  append(jobId: string, text: string): DevboxJobLogAppendResult {
    this.assertId(jobId)
    const input = String(text)
    const inputBytes = bytes(input)
    if (inputBytes === 0) {
      return { acceptedBytes: 0, droppedBytes: 0, droppedMarker: null }
    }
    const current = this.path(jobId)
    const rotated = `${current}.1`
    if (existsSync(current)) {
      chmodSync(current, 0o600)
    }
    if (existsSync(rotated)) {
      chmodSync(rotated, 0o600)
    }
    const currentBytes = this.size(current)
    const rotatedBytes = this.size(rotated)
    const total = this.totalBytes()
    if (total >= this.globalBytes) {
      return this.drop(jobId, inputBytes, 'global quota')
    }
    let payload = input
    let acceptedBytes = inputBytes
    let dropped = 0
    let droppedMarker: string | null = null
    if (currentBytes + rotatedBytes + inputBytes > this.perJobBytes) {
      this.rotate(current, rotated)
      const rotatedAfter = this.size(rotated)
      const available = Math.min(
        Math.max(0, this.perJobBytes - rotatedAfter),
        Math.max(0, this.globalBytes - this.totalBytes())
      )
      const fitted = fitRotatedPayload(jobId, input, inputBytes, available, 'per-job quota')
      payload = fitted.payload
      acceptedBytes = fitted.acceptedBytes
      dropped = fitted.droppedBytes
      droppedMarker = dropped > 0 ? marker(jobId, dropped, 'per-job quota') : null
    }
    const room = Math.max(0, this.globalBytes - this.totalBytes())
    if (bytes(payload) > room) {
      return this.drop(jobId, inputBytes, 'global quota')
    }
    if (payload.length > 0 || !existsSync(current)) {
      // Keep the current-file path stable even when a full rotated file leaves
      // no room for a persisted marker; the marker remains in tail metadata.
      appendFileSync(current, payload, { encoding: 'utf8', mode: 0o600 })
      chmodSync(current, 0o600)
    }
    if (droppedMarker) {
      this.rememberMarker(jobId, droppedMarker)
    }
    return {
      acceptedBytes,
      droppedBytes: dropped,
      droppedMarker
    }
  }

  tail(jobId: string, offset = 0, limit = 64 * 1024): DevboxJobLogTail {
    this.assertId(jobId)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('Invalid workload log tail range.')
    }
    const content = Buffer.concat(
      [this.path(jobId), `${this.path(jobId)}.1`]
        .toReversed()
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file))
    )
    const sliced = content.subarray(offset, offset + limit)
    return {
      jobId,
      offset,
      nextOffset: offset + sliced.length,
      text: sliced.toString('utf8'),
      droppedMarkers: [...(this.markers.get(jobId) ?? [])],
      sensitive: true,
      includeInDiagnostics: false
    }
  }

  pathFor(jobId: string): string {
    this.assertId(jobId)
    return this.path(jobId)
  }

  private path(jobId: string): string {
    const path = join(this.rootDir, `${jobId}.log`)
    registerDevboxJobLogPath(path)
    return path
  }

  private size(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  private totalBytes(): number {
    return readdirSync(this.rootDir)
      .filter((name) => name.endsWith('.log') || name.endsWith('.log.1'))
      .reduce((total, name) => total + this.size(join(this.rootDir, name)), 0)
  }

  private rotate(current: string, rotated: string): void {
    if (existsSync(rotated)) {
      renameSync(rotated, `${rotated}.old`)
    }
    if (existsSync(current)) {
      renameSync(current, rotated)
    }
    const old = `${rotated}.old`
    if (existsSync(old)) {
      try {
        unlinkSync(old)
      } catch {
        // A stale rotation must never make workload logging fail the job.
      }
    }
  }

  private drop(jobId: string, dropped: number, reason: string): DevboxJobLogAppendResult {
    const droppedMarker = marker(jobId, dropped, reason)
    this.rememberMarker(jobId, droppedMarker)
    return { acceptedBytes: 0, droppedBytes: dropped, droppedMarker }
  }

  private rememberMarker(jobId: string, value: string): void {
    const values = this.markers.get(jobId) ?? []
    values.push(value)
    this.markers.set(jobId, values.slice(-32))
  }

  private assertId(jobId: string): void {
    if (!safeId(jobId)) {
      throw new Error('Invalid Devbox job identifier.')
    }
  }
}
