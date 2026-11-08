import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startDevboxLoginRelay } from './shell-login-relay'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function fetchText(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: options.method, headers: options.headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.once('error', reject)
    if (options.body !== undefined) {
      request.write(options.body)
    }
    request.end()
  })
}

describe('local login relay', () => {
  it('serves ping, authenticates events, binds, relays, releases, and logs', async () => {
    const port = await freePort()
    const lines: string[] = []
    const relay = await startDevboxLoginRelay({
      ports: [port],
      deviceLabel: 'workstation',
      log: (line) => lines.push(line),
      forward: async () => 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Ignored: yes\r\n\r\nlogin-ok'
    })
    try {
      await expect(fetchText(relay.controlPort, '/ping')).resolves.toMatchObject({ status: 200, body: 'ok' })
      await expect(fetchText(relay.controlPort, '/event', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'listener', port, up: true })
      })).resolves.toMatchObject({ status: 401 })
      await expect(fetchText(relay.controlPort, '/event', {
        method: 'POST',
        headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
        body: '{bad'
      })).resolves.toMatchObject({ status: 400 })
      await fetchText(relay.controlPort, '/event', {
        method: 'POST',
        headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'listener', port, up: true })
      })
      expect(relay.boundPorts()).toEqual([port])
      await expect(fetchText(port, '/callback?code=ok')).resolves.toMatchObject({ status: 200, body: 'login-ok' })
      expect(relay.boundPorts()).toEqual([])
      expect(lines.find((line) => line.includes('path=/callback'))).toContain(`device=workstation port=${port} path=/callback status=200`)
      expect(lines.some((line) => line.includes(`event port=${port} up=true`))).toBe(true)
      expect(lines.some((line) => line.includes(`port=${port} released`))).toBe(true)
    } finally {
      await relay.stop()
    }
  })

  it('renders a refused forward as an escaped manual fallback and handles favicon', async () => {
    const port = await freePort()
    const relay = await startDevboxLoginRelay({
      ports: [port],
      deviceLabel: '<workstation>',
      forward: async () => { throw new Error('curl exit 7') }
    })
    try {
      await relay.handleEvent?.({ event: 'listener', port, up: true })
      const result = await fetchText(port, '/callback?x=<script>')
      expect(result.status).toBe(502)
      expect(result.body).toContain('No login is waiting on &lt;workstation&gt;')
      expect(result.body).toContain('http://localhost:')
      expect(result.body).toContain('&lt;script&gt;')
      await relay.handleEvent?.({ event: 'listener', port, up: true })
      await expect(fetchText(port, '/favicon.ico')).resolves.toMatchObject({ status: 404 })
    } finally {
      await relay.stop()
    }
  })

  it('tolerates EADDRINUSE and stop closes the control server', async () => {
    const port = await freePort()
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(port, '127.0.0.1', resolve))
    const relay = await startDevboxLoginRelay({ ports: [port], deviceLabel: 'macmini', forward: async () => '' })
    try {
      await relay.handleEvent?.({ event: 'listener', port, up: true })
      expect(relay.boundPorts()).toEqual([])
    } finally {
      await relay.stop()
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
    await expect(fetchText(relay.controlPort, '/ping')).rejects.toBeDefined()
  })

  it('serializes requests and supports token rotation for reconnect attempts', async () => {
    const port = await freePort()
    let active = 0
    let maximum = 0
    const relay = await startDevboxLoginRelay({
      ports: [port],
      deviceLabel: 'workstation',
      forward: async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return 'HTTP/1.1 200 OK\r\n\r\nok'
      }
    })
    try {
      const rotated = 'abcdefabcdefabcdefabcdefabcdefab'
      relay.setToken?.(rotated)
      await relay.handleEvent?.({ event: 'listener', port, up: true })
      await Promise.all([fetchText(port, '/a'), fetchText(port, '/b')])
      expect(maximum).toBe(1)
    } finally {
      await relay.stop()
    }
  })
})
