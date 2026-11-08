import { shellEscape } from '../ssh/shell-escape'

const DEFAULT_PORTS = [53692, 1455, 1456] as const

export type DevboxRawHttpResponse = {
  statusCode: number
  contentType?: string
  body: string
}

export function buildDevboxLoginRelayPrepareScript(): string {
  return [
    'set -Eeuo pipefail',
    'd="${XDG_RUNTIME_DIR:-}"',
    '[ -n "$d" ] || d="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"',
    '[ -n "$d" ] || d=/tmp',
    'dir="${d%/}/devbox-relay"',
    'mkdir -p "$dir"',
    'chmod 700 "$dir"',
    'for s in "$dir"/*.sock; do',
    '  [ -e "$s" ] || continue',
    '  curl -s -m 1 --unix-socket "$s" http://devbox/ping >/dev/null 2>&1 || rm -f "$s"',
    'done',
    'printf \'%s\\n\' "$dir"'
  ].join('\n')
}

export function buildDevboxLoginRelayWatcherScript(input: {
  socketPath: string
  token: string
  ports: readonly number[]
}): string {
  validateSocketToken(input.socketPath, input.token)
  const ports = normalizePorts(input.ports)
  const stateNames = ports.map((port) => `state_${port}`)
  const declarations = stateNames.map((name) => `${name}=unknown`)
  const probes = ports.map((port, index) => [
    `  if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then`,
    '    exec 3>&-',
    '    state=true',
    '  else',
    '    state=false',
    '  fi',
    `  if [ "$state" != "${'$'}${stateNames[index]}" ]; then`,
    `    curl -s -m 3 --unix-socket "$sock" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data "{\\"event\\":\\"listener\\",\\"port\\":${port},\\"up\\":$state}" http://devbox/event >/dev/null 2>&1 || true`,
    `    ${stateNames[index]}=$state`,
    '  fi'
  ].join('\n'))
  return [
    `sock=${shellEscape(input.socketPath)}`,
    `token=${shellEscape(input.token)}`,
    `ports=${shellEscape(ports.join(' '))}`,
    ...declarations,
    'iterations=0',
    // The forwarded socket dies with the ssh session; remove the stale file on every exit path.
    'trap \'rm -f "$sock"; exit 0\' HUP TERM INT',
    'trap \'rm -f "$sock"\' EXIT',
    'command -v curl >/dev/null 2>&1 || exit 0',
    'while [ "$iterations" -lt 86400 ]; do',
    '  curl -s -m 2 --unix-socket "$sock" http://devbox/ping >/dev/null 2>&1 || { rm -f "$sock"; exit 0; }',
    ...probes,
    '  iterations=$((iterations + 1))',
    '  sleep 1',
    'done'
  ].join('\n')
}

export function buildDevboxLoginRelayForwardScript(port: number, url: string): string {
  assertPort(port)
  if (!url.startsWith('/') || /[\s\p{Cc}]/u.test(url) || url.length > 8192) {
    throw new Error('Invalid login relay URL')
  }
  const target = `http://127.0.0.1:${port}${url}`
  const quotedTarget = shellEscape(target)
  const quotedPath = shellEscape(url)
  return [
    'set -o pipefail',
    `if command -v curl >/dev/null 2>&1; then curl -s -i -m 15 --noproxy '*' ${quotedTarget}; else`,
    `  { exec 3<>/dev/tcp/127.0.0.1/${port}; printf 'GET %s HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' ${quotedPath} >&3; cat <&3; }`,
    'fi'
  ].join('\n')
}

export function parseDevboxLoginRelayPrepareOutput(stdout: string): string {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0)
  if (lines.length !== 1) {
    throw new Error('Login relay prepare step returned an invalid directory')
  }
  const dir = lines[0]!
  if (!dir.startsWith('/') || dir.length > 200 || /[\s\p{Cc}]/u.test(dir)) {
    throw new Error('Login relay prepare step returned an invalid directory')
  }
  return dir
}

export function parseDevboxRawHttpResponse(text: string): DevboxRawHttpResponse {
  const crlfSeparator = text.indexOf('\r\n\r\n')
  const separator = text.includes('\r\n\r\n') ? crlfSeparator : text.indexOf('\n\n')
  if (separator < 0) {
    throw new Error('Login relay returned an invalid HTTP response')
  }
  const delimiterLength = text.startsWith('\r\n\r\n', separator) ? 4 : 2
  const headerText = text.slice(0, separator)
  const body = text.slice(separator + delimiterLength)
  const lines = headerText.split(/\r?\n/u)
  const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/u.exec(lines.shift() ?? '')
  const statusCode = Number(match?.[1])
  if (!match || statusCode < 100 || statusCode > 599) {
    throw new Error('Login relay returned an invalid HTTP status')
  }
  let contentType: string | undefined
  for (const line of lines) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0 || line.slice(0, separatorIndex).trim().toLowerCase() !== 'content-type') {
      continue
    }
    contentType = line.slice(separatorIndex + 1).trim()
    break
  }
  return { statusCode, ...(contentType === undefined ? {} : { contentType }), body }
}

export function resolveDevboxLoginRelayPorts(env: NodeJS.ProcessEnv): number[] {
  const raw = env.DEVBOX_LOGIN_RELAY_PORTS?.trim()
  if (!raw) {
    return [...DEFAULT_PORTS]
  }
  const values = raw.split(',').map((value) => value.trim())
  const ports = values.map((value) => Number(value))
  if (values.some((value, index) => !/^\d+$/u.test(value) || !Number.isInteger(ports[index]) || ports[index]! < 1024 || ports[index]! > 65535)) {
    throw new Error('DEVBOX_LOGIN_RELAY_PORTS must contain comma-separated ports from 1024 to 65535')
  }
  return [...new Set(ports)]
}

export function isDevboxLoginRelayEnabled(env: NodeJS.ProcessEnv, flagDisabled: boolean): boolean {
  return !flagDisabled && env.DEVBOX_SHELL_LOGIN_RELAY !== '0'
}

function normalizePorts(ports: readonly number[]): number[] {
  if (ports.length === 0) {
    throw new Error('Login relay requires at least one port')
  }
  const normalized = [...new Set(ports)]
  normalized.forEach(assertPort)
  return normalized
}

function validateSocketToken(socketPath: string, token: string): void {
  if (!socketPath.startsWith('/') || /[\s\p{Cc}]/u.test(socketPath)) {
    throw new Error('Invalid login relay socket path')
  }
  if (!/^[0-9a-f]{32}$/u.test(token)) {
    throw new Error('Invalid login relay token')
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Login relay port must be between 1024 and 65535')
  }
}
