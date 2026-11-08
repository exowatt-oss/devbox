import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { connect as connectTcp } from 'node:net'
import { dirname, join } from 'node:path'
import { Server, type ServerChannel } from 'ssh2'
import { handleScpSink } from './scp-sink'

const LOOPBACK = '127.0.0.1'

export type FixtureHostKey = {
  privateKey: string
  publicKey: string
  fingerprint: string
}

export type FixtureSshServer = {
  host: typeof LOOPBACK
  port: number
  hostKey: FixtureHostKey
  homeDirectory: string
  sshBinaryPath: string
  scpBinaryPath: string
  forwardedConnections: number
  close: () => Promise<void>
}

type MutableServerState = FixtureSshServer & {
  forwardedConnections: number
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4)
  result.writeUInt32BE(value)
  return result
}

function sshField(value: Buffer): Buffer {
  return Buffer.concat([uint32(value.length), value])
}

function sshMpint(value: Buffer): Buffer {
  let normalized = value
  while (normalized.length > 1 && normalized[0] === 0) {
    normalized = normalized.subarray(1)
  }
  if (normalized[0] !== undefined && (normalized[0] & 0x80) !== 0) {
    normalized = Buffer.concat([Buffer.from([0]), normalized])
  }
  return sshField(normalized)
}

function keyMaterial(): FixtureHostKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as { e?: string; n?: string }
  if (!jwk.e || !jwk.n) {
    throw new Error('fixture RSA public key did not export as JWK')
  }
  // ssh2 1.17.0 accepts classic RSA PKCS#1 PEM, not Node's Ed25519 PKCS#8 PEM.
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs1' })
  if (typeof privateKeyPem !== 'string') {
    throw new Error('fixture RSA private key did not export as PEM')
  }
  const type = Buffer.from('ssh-rsa')
  const blob = Buffer.concat([
    sshField(type),
    sshMpint(Buffer.from(jwk.e, 'base64url')),
    sshMpint(Buffer.from(jwk.n, 'base64url'))
  ])
  const encoded = blob.toString('base64')
  const fingerprint = `SHA256:${createHash('sha256')
    .update(blob)
    .digest('base64')
    .replace(/=+$/u, '')}`
  return {
    privateKey: privateKeyPem,
    publicKey: `ssh-rsa ${encoded}`,
    fingerprint
  }
}

function installFixtureAgent(homeDirectory: string, mutagenBinary: string): void {
  // Seed the exact sidecar agent in the ephemeral remote home. The shell
  // emulation is intentionally minimal, so transport starts at agent protocol.
  const archivePath = join(dirname(mutagenBinary), 'mutagen-agents.tar.gz')
  const agentPath = join(homeDirectory, '.mutagen', 'agents', '0.18.1', 'mutagen-agent')
  mkdirSync(dirname(agentPath), { recursive: true })
  // The fixture "remote" runs on this host, so stage the agent matching the
  // local platform (the archive bundles every platform).
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const agent = execFileSync('/usr/bin/tar', ['-xOzf', archivePath, `${platform}_${arch}`], {
    maxBuffer: 32 * 1024 * 1024
  })
  writeFileSync(agentPath, agent, { mode: 0o700 })
}

function userKeyPath(homeDirectory: string): string {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'der', type: 'spki' }
  })
  const path = join(homeDirectory, 'fixture-user-key')
  writeFileSync(path, privateKey, { mode: 0o600 })
  return path
}

function commandEnvironment(homeDirectory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDirectory,
    USER: 'fixture',
    LOGNAME: 'fixture',
    PATH: `/usr/bin:/bin:${homeDirectory}`
  }
}

function handleExec(
  channel: ServerChannel,
  command: string,
  homeDirectory: string,
  mutagenBinary: string
): void {
  if (/\bscp\s+-t(?:\s|$)/u.test(command)) {
    handleScpSink(channel, homeDirectory, command)
    return
  }

  const child = spawn('/bin/sh', ['-lc', command], {
    cwd: homeDirectory,
    env: { ...commandEnvironment(homeDirectory), MUTAGEN_FIXTURE_BINARY: mutagenBinary },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.pipe(channel)
  child.stderr.pipe(channel.stderr)
  channel.pipe(child.stdin)
  const stopChild = (): void => {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }
  channel.on('close', stopChild)
  child.on('error', (error) => {
    channel.stderr.write(`${error.message}\n`)
    channel.exit(1)
    channel.end()
  })
  child.on('close', (code) => {
    channel.exit(code ?? 1)
    channel.end()
  })
}

function handleForward(
  channel: ServerChannel,
  host: string,
  port: number,
  state: MutableServerState
): void {
  state.forwardedConnections += 1
  const socket = connectTcp(port, host)
  socket.on('connect', () => {
    channel.pipe(socket)
    socket.pipe(channel)
  })
  socket.on('error', () => {
    channel.close()
  })
  channel.on('close', () => socket.destroy())
}

export async function startFixtureSshServer(
  rootDirectory: string,
  mutagenBinary: string
): Promise<FixtureSshServer> {
  const homeDirectory = join(rootDirectory, 'home')
  mkdirSync(join(homeDirectory, 'workspace'), { recursive: true })
  installFixtureAgent(homeDirectory, mutagenBinary)
  const hostKey = keyMaterial()
  const identityPath = userKeyPath(homeDirectory)
  const server = new Server({ hostKeys: [hostKey.privateKey] })
  const state: MutableServerState = {
    host: LOOPBACK,
    port: 0,
    hostKey,
    homeDirectory,
    sshBinaryPath: '',
    scpBinaryPath: '',
    forwardedConnections: 0,
    close: async () => undefined
  }

  server.on('connection', (connection) => {
    connection.on('error', () => undefined)
    connection.on('authentication', (context) => {
      if (context.method === 'publickey' || context.method === 'none') {
        context.accept()
      } else {
        context.reject()
      }
    })
    connection.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== LOOPBACK) {
        reject()
        return
      }
      handleForward(accept(), info.destIP, info.destPort, state)
    })
    connection.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptChannel, _reject, info) => {
        handleExec(acceptChannel(), info.command, homeDirectory, mutagenBinary)
      })
      session.on('shell', (_acceptChannel, reject) => reject())
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('fixture SSH server did not expose a TCP address')
  }
  state.port = address.port
  const sshBinary = join(rootDirectory, 'ssh')
  const scpBinary = join(rootDirectory, 'scp')
  const key = JSON.stringify(identityPath)
  writeFileSync(sshBinary, `#!/bin/sh\nexec /usr/bin/ssh -i ${key} -o IdentitiesOnly=yes "$@"\n`, {
    mode: 0o700
  })
  writeFileSync(
    scpBinary,
    `#!/bin/sh\nexec /usr/bin/scp -O -i ${key} -o IdentitiesOnly=yes "$@"\n`,
    { mode: 0o700 }
  )
  state.sshBinaryPath = sshBinary
  state.scpBinaryPath = scpBinary
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return state
}
