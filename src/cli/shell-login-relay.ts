import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  buildDevboxLoginRelayForwardScript,
  parseDevboxRawHttpResponse
} from './shell-login-relay-remote'

type RelayForward = (script: string, timeoutMs?: number) => Promise<string>

export type DevboxLoginRelayOptions = {
  forward: RelayForward
  ports: readonly number[]
  deviceLabel: string
  log?: (line: string) => void
  host?: '127.0.0.1'
  bindTimeoutMs?: number
}

export type DevboxLoginRelayHandle = {
  controlPort: number
  token: string
  boundPorts(): number[]
  handleEvent?(event: { event: 'listener'; port: number; up: boolean }): Promise<void>
  stop(): Promise<void>
  setToken?(token: string): void
}

type CallbackEntry = { server: Server; timer: ReturnType<typeof setTimeout> }
const DEFAULT_BIND_TIMEOUT_MS = 5_000
const CALLBACK_SAFETY_MS = 20 * 60 * 1_000
const MAX_EVENT_BODY = 4 * 1024

export async function startDevboxLoginRelay(options: DevboxLoginRelayOptions): Promise<DevboxLoginRelayHandle> {
  const host = options.host ?? '127.0.0.1'
  const ports = [...new Set(options.ports)]
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error('Login relay callback ports must be between 1024 and 65535')
  }
  const allowed = new Set(ports)
  let token = randomBytes(16).toString('hex')
  let stopped = false
  const callbacks = new Map<number, CallbackEntry>()
  let relayQueue = Promise.resolve()
  let controlServer: Server | undefined

  const boundPorts = (): number[] => [...callbacks.keys()].sort((a, b) => a - b)
  const releasePort = async (port: number, force = false): Promise<void> => {
    const entry = callbacks.get(port)
    if (!entry) {
      return
    }
    callbacks.delete(port)
    clearTimeout(entry.timer)
    await closeServer(entry.server, force)
    note(`port=${port} released`)
  }
  const bindPort = async (port: number): Promise<void> => {
    if (stopped || callbacks.has(port)) {
      return
    }
    const server = createServer((request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(request.method === 'HEAD' ? undefined : 'Method not allowed')
        return
      }
      const url = request.url ?? ''
      if (url === '/favicon.ico') {
        response.writeHead(404)
        response.end()
        return
      }
      if (!isSafeRelayUrl(url)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(request.method === 'HEAD' ? undefined : 'Bad callback URL')
        return
      }
      relayQueue = relayQueue.then(() => relayRequest(port, url, request, response)).catch(() => undefined)
    })
    const entry = await listenServer(server, host, port, options.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS)
    if (!entry) {
      note(`port=${port} bind=skipped (local port busy)`)
      return
    }
    note(`port=${port} bind=ok`)
    const timer = setTimeout(() => { void releasePort(port) }, CALLBACK_SAFETY_MS)
    timer.unref()
    callbacks.set(port, { server, timer })
  }
  const handleEvent = async (event: { event: 'listener'; port: number; up: boolean }): Promise<void> => {
    if (!allowed.has(event.port) || typeof event.up !== 'boolean') {
      throw new Error('Invalid login relay event')
    }
    note(`event port=${event.port} up=${event.up}`)
    await (event.up ? bindPort(event.port) : releasePort(event.port))
  }
  const note = (detail: string): void => {
    try {
      options.log?.(`${new Date().toISOString()} device=${options.deviceLabel} ${detail}`)
    } catch {
      // Relay logging is best effort.
    }
  }
  const controlHandler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/ping') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('ok')
      return
    }
    if (request.method !== 'POST' || url !== '/event') {
      response.writeHead(404)
      response.end()
      return
    }
    const authorization = request.headers.authorization
    if (authorization !== `Bearer ${token}`) {
      response.writeHead(401)
      response.end()
      return
    }
    void readBody(request).then(async (body) => {
      try {
        const event = JSON.parse(body) as { event?: unknown; port?: unknown; up?: unknown }
        if (event.event !== 'listener' || typeof event.port !== 'number' || typeof event.up !== 'boolean' || !Number.isInteger(event.port)) {
          throw new Error('bad event')
        }
        await handleEvent({ event: 'listener', port: event.port, up: event.up })
        response.writeHead(204)
        response.end()
      } catch {
        response.writeHead(400)
        response.end()
      }
    }).catch(() => {
      response.writeHead(400)
      response.end()
    })
  }
  controlServer = createServer(controlHandler)
  const listening = await listenServer(controlServer, host, 0, options.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS)
  if (!listening) {
    throw new Error('Unable to bind login relay control server')
  }
  const controlPort = addressPort(controlServer)
  const stop = async (): Promise<void> => {
    if (stopped) {
      return
    }
    stopped = true
    await Promise.all([...callbacks.keys()].map((port) => releasePort(port, true)))
    await closeServer(controlServer, true)
  }
  return {
    controlPort,
    get token() { return token },
    boundPorts,
    handleEvent,
    stop,
    setToken: (nextToken) => {
      if (/^[0-9a-f]{32}$/u.test(nextToken)) {
        token = nextToken
      }
    }
  }

  async function relayRequest(port: number, url: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (stopped) {
      response.writeHead(503)
      response.end()
      return
    }
    let statusCode = 502
    let contentType = 'text/html; charset=utf-8'
    let body = fallbackPage(options.deviceLabel, port, url)
    try {
      const raw = await options.forward(buildDevboxLoginRelayForwardScript(port, url), 20_000)
      const parsed = parseDevboxRawHttpResponse(raw)
      statusCode = parsed.statusCode
      contentType = parsed.contentType ?? contentType
      body = parsed.body
    } catch {
      // A refused hub callback is rendered as the manual-paste fallback page.
    }
    response.writeHead(statusCode, { 'Content-Type': contentType })
    response.end(request.method === 'HEAD' ? undefined : body)
    try {
      options.log?.(`${new Date().toISOString()} device=${options.deviceLabel} port=${port} path=${url.split('?')[0]} status=${statusCode}`)
    } catch {
      // Relay logging is best effort.
    }
    if (statusCode >= 200 && statusCode < 300) {
      void releasePort(port)
    }
  }
}

function listenServer(server: Server, host: string, port: number, timeoutMs: number): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      server.close()
      resolve(undefined)
    }, timeoutMs)
    const finish = (value: Server | undefined, error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish(undefined)
      } else {
        finish(undefined, error)
      }
    })
    server.listen(port, host, () => finish(server))
  })
}

function addressPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Login relay control server has no port')
  }
  return address.port
}

function closeServer(server: Server | undefined, force = false): Promise<void> {
  if (!server || !server.listening) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    server.close(() => resolve())
    // Browsers keep the callback connection alive; never let that delay a port
    // release or the shell exit. A forced close (relay teardown) also drops
    // requests still in flight; a release keeps them until they are answered.
    if (force) {
      server.closeAllConnections()
    } else {
      server.closeIdleConnections()
    }
  })
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ''
    let tooLarge = false
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      if (value.length + chunk.length > MAX_EVENT_BODY) {
        tooLarge = true
      } else if (!tooLarge) {
        value += chunk
      }
    })
    request.once('end', () => tooLarge ? reject(new Error('event body too large')) : resolve(value))
    request.once('error', reject)
  })
}

function isSafeRelayUrl(url: string): boolean {
  return url.startsWith('/') && url.length <= 8192 && !/[\s\p{Cc}]/u.test(url)
}

function fallbackPage(device: string, port: number, url: string): string {
  const fullUrl = `http://localhost:${port}${url}`
  return `<!doctype html><meta charset="utf-8"><title>Devbox login relay</title><p>No login is waiting on ${escapeHtml(device)} — paste this URL into the phi prompt:</p><p><code>${escapeHtml(fullUrl)}</code></p>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
