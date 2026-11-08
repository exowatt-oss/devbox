import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knownHostsToken, normalizeDevboxProxyCommand } from '../ssh/ssh-proxy'
import type { ScannedKey } from './profile-create'

/** Host-key algorithms probed one connection each (ssh-keyscan cannot use a ProxyCommand). */
export const PROXY_KEYSCAN_ALGORITHMS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512'] as const

export type ProxyKeyscanOptions = {
  sshBinary?: string
  /** The first probe may have to wake a stopped box, so it gets a long budget. */
  firstTimeoutMs?: number
  timeoutMs?: number
}

/**
 * argv for one host-key probe through the proxy. The user's ssh config is
 * ignored (-F /dev/null) and every authentication method is off: the probe only
 * completes key exchange, during which StrictHostKeyChecking=accept-new records
 * the server key under HostKeyAlias=<token> in the empty scratch known_hosts.
 */
export function buildProxyKeyscanArgv(input: {
  host: string
  port: number
  username: string
  proxyCommand: string
  knownHostsFile: string
  algorithm: string
}): string[] {
  const option = (value: string): string[] => ['-o', value]
  return [
    '-F', '/dev/null',
    ...option('BatchMode=yes'),
    ...option(`ProxyCommand=${normalizeDevboxProxyCommand(input.proxyCommand)}`),
    ...option(`HostKeyAlias=${knownHostsToken(input.host, input.port)}`),
    ...option(`UserKnownHostsFile=${input.knownHostsFile}`),
    ...option('GlobalKnownHostsFile=/dev/null'),
    ...option('StrictHostKeyChecking=accept-new'),
    ...option('HashKnownHosts=no'),
    ...option('UpdateHostKeys=no'),
    ...option('CheckHostIP=no'),
    ...option(`HostKeyAlgorithms=${input.algorithm}`),
    ...option('PubkeyAuthentication=no'),
    ...option('PasswordAuthentication=no'),
    ...option('KbdInteractiveAuthentication=no'),
    ...option('GSSAPIAuthentication=no'),
    ...option('ControlMaster=no'),
    ...option('ControlPath=none'),
    ...option('ClearAllForwardings=yes'),
    ...option('LogLevel=ERROR'),
    '-p', String(input.port), '--', `${input.username}@${input.host}`, 'true'
  ]
}

/** Reads the server host keys through a ProxyCommand, one probe per algorithm. */
export async function scanSshKeysThroughProxy(
  host: string,
  port: number,
  username: string,
  proxyCommand: string,
  options: ProxyKeyscanOptions = {}
): Promise<ScannedKey[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'devbox-proxy-keyscan-'))
  const keys: ScannedKey[] = []
  try {
    for (const [index, algorithm] of PROXY_KEYSCAN_ALGORITHMS.entries()) {
      const knownHostsFile = join(scratch, `known_hosts-${index}`)
      await writeFile(knownHostsFile, '', { mode: 0o600 })
      const argv = buildProxyKeyscanArgv({ host, port, username, proxyCommand, knownHostsFile, algorithm })
      const timeout = index === 0 ? options.firstTimeoutMs ?? 420_000 : options.timeoutMs ?? 60_000
      await runProbe(options.sshBinary ?? 'ssh', argv, timeout)
      keys.push(...parseKnownHostsLines(await readFile(knownHostsFile, 'utf8')))
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const unique = keys.filter((key, index) => keys.findIndex((other) => other.line === key.line) === index)
  if (unique.length === 0) {
    throw new Error(`SSH host key probe through the proxy command returned no keys for ${username}@${host}:${port}`)
  }
  return unique
}

function parseKnownHostsLines(content: string): ScannedKey[] {
  return content.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 3 || fields[0]!.startsWith('#') || fields[0]!.startsWith('@')) {return []}
    return [{ type: fields[1]!, blob: Buffer.from(fields[2]!, 'base64'), line: `${fields[0]} ${fields[1]} ${fields[2]}\n` }]
  })
}

/** Exit status is irrelevant: authentication is expected to fail after the key is recorded. */
function runProbe(binary: string, argv: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr?.resume()
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}
