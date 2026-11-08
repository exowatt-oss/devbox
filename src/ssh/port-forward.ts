import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer } from 'node:net'
import type { SshEndpoint } from '../shared/ssh-runner-types'
import { DEFAULT_SSH_TIMEOUT_MS } from './system-ssh-runner'

export type PortForwardEntry = {
  id: string
  connectionId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
  scope?: 'persistent' | 'ephemeral'
  owner?: {
    kind: 'mcp-oauth'
    leaseId: string
    relayEpoch: string
  }
  relayGeneration?: string
  advertisedUrl?: string
  advertisedProtocol?: 'http' | 'https'
}

export const SSH_FORWARD_STARTUP_TIMEOUT_MS = 10_000
export const SSH_FORWARD_PROBE_INTERVAL_MS = 50

export function buildSshPortForwardArgv(
  endpoint: SshEndpoint,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  timeoutMs = DEFAULT_SSH_TIMEOUT_MS
): string[] {
  validateEndpoint(endpoint)
  validatePort(localPort, 'local')
  validatePort(remotePort, 'remote')
  assertNoNul(remoteHost, 'remote host')
  const args = [
    '-N',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`
  ]
  if (endpoint.knownHostsFile !== undefined) {
    args.push('-o', `UserKnownHostsFile=${endpoint.knownHostsFile}`)
  }
  for (const option of endpoint.extraOptions ?? []) {
    assertNoNul(option, 'SSH option')
    args.push('-o', option)
  }
  args.push('-p', String(endpoint.port), '--', `${endpoint.username}@${endpoint.host}`)
  return args
}

export function createSshPortForwarder(
  endpoint: SshEndpoint,
  options: { sshBinary?: string } = {}
): {
  openForward(req: {
    remoteHost: string
    remotePort: number
    label?: string
  }): Promise<{ entry: PortForwardEntry; close(): Promise<void> }>
} {
  const sshBinary = options.sshBinary ?? 'ssh'
  assertNoNul(sshBinary, 'SSH binary')
  validateEndpoint(endpoint)
  let nextId = 1
  const connectionId = `${endpoint.username}@${endpoint.host}:${endpoint.port}`

  return {
    openForward: async (req) => {
      assertNoNul(req.remoteHost, 'remote host')
      validatePort(req.remotePort, 'remote')
      const localPort = await allocateFreeLocalPort()
      const child = spawn(
        sshBinary,
        buildSshPortForwardArgv(endpoint, localPort, req.remoteHost, req.remotePort),
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
      )
      const close = createCloseFunction(child)
      try {
        await waitForForwardReady(child, localPort)
      } catch (error) {
        await close()
        throw error
      }
      const entry: PortForwardEntry = {
        id: `pf-${nextId++}`,
        connectionId,
        localPort,
        remoteHost: req.remoteHost,
        remotePort: req.remotePort,
        ...(req.label === undefined ? {} : { label: req.label })
      }
      return { entry, close }
    }
  }
}

export function allocateFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not determine the allocated local SSH forward port'))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve(address.port)
        }
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
}

function waitForForwardReady(child: ChildProcess, localPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let stderr = ''
    let settled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
      }
      child.stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8')
    }
    const onError = (error: Error): void => {
      finish(forwardError('SSH port forward process failed', null, stderr, error))
    }
    const onClose = (code: number | null): void => {
      finish(forwardError('SSH port forward failed', code, stderr))
    }
    const probe = (): void => {
      if (settled) {
        return
      }
      probeLocalPort(localPort).then(
        () => finish(),
        () => {
          if (Date.now() - startedAt >= SSH_FORWARD_STARTUP_TIMEOUT_MS) {
            finish(
              new Error(
                `SSH port forward did not become ready on 127.0.0.1:${localPort} within ${SSH_FORWARD_STARTUP_TIMEOUT_MS}ms (exit ${child.exitCode ?? 'still running'})${stderr.trim() ? `: ${stderr.trim()}` : ''}`
              )
            )
            return
          }
          retryTimer = setTimeout(probe, SSH_FORWARD_PROBE_INTERVAL_MS)
        }
      )
    }

    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    retryTimer = setTimeout(probe, 0)
  })
}

function probeLocalPort(localPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: localPort })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    socket.setTimeout(SSH_FORWARD_PROBE_INTERVAL_MS)
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
    socket.once('timeout', () => finish(new Error('SSH forward probe timed out')))
  })
}

function createCloseFunction(child: ChildProcess): () => Promise<void> {
  let closePromise: Promise<void> | undefined
  return () => {
    closePromise ??= stopChild(child)
    return closePromise
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const escalationTimer = setTimeout(() => {
      killChild(child, 'SIGKILL')
    }, 2_000)
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(escalationTimer)
      child.off('close', onClose)
      child.off('error', onError)
      resolve()
    }
    const onClose = (): void => finish()
    const onError = (): void => finish()
    child.once('close', onClose)
    child.once('error', onError)
    if (child.exitCode !== null || child.signalCode !== null || !killChild(child, 'SIGTERM')) {
      finish()
    }
  })
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

function forwardError(prefix: string, exitCode: number | null, stderr: string, cause?: Error): Error {
  const detail = stderr.trim()
  const status = exitCode === null ? '' : ` (exit ${exitCode})`
  return new Error(`${prefix}${status}${detail ? `: ${detail}` : ''}`, { cause })
}

function validateEndpoint(endpoint: SshEndpoint): void {
  assertNoNul(endpoint.host, 'SSH host')
  assertNoNul(endpoint.username, 'SSH username')
  assertNoNul(endpoint.knownHostsFile, 'known_hosts path')
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
    throw new Error('SSH port must be an integer from 1 to 65535')
  }
  for (const option of endpoint.extraOptions ?? []) {
    assertNoNul(option, 'SSH option')
    if (/[\r\n]/u.test(option)) {
      throw new Error('SSH option must not contain newlines')
    }
  }
}

function validatePort(port: number, kind: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${kind} port must be an integer from 1 to 65535`)
  }
}

function assertNoNul(value: string | undefined, label: string): void {
  if (value?.includes('\0')) {
    throw new Error(`${label} must not contain NUL`)
  }
}
