import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  buildDevboxLoginRelayForwardScript,
  buildDevboxLoginRelayPrepareScript,
  buildDevboxLoginRelayWatcherScript,
  isDevboxLoginRelayEnabled,
  parseDevboxLoginRelayPrepareOutput,
  parseDevboxRawHttpResponse,
  resolveDevboxLoginRelayPorts
} from './shell-login-relay-remote'

describe('login relay remote scripts', () => {
  it('prepares and garbage-collects the remote socket directory', () => {
    const script = buildDevboxLoginRelayPrepareScript()
    expect(script).toContain('mkdir -p "$dir"')
    expect(script).toContain('chmod 700 "$dir"')
    expect(script).toContain('curl -s -m 1 --unix-socket "$s" http://devbox/ping')
    expect(script).toContain('rm -f "$s"')
    expect(script).toContain('getconf DARWIN_USER_TEMP_DIR')
  })

  it('includes a heartbeat, bash port probes, bearer token POST, and 24-hour bound', () => {
    const script = buildDevboxLoginRelayWatcherScript({
      socketPath: '/tmp/devbox-relay/0123456789abcdef.sock',
      token: Buffer.from('synthetic-relay-canary').toString('hex').slice(0, 32),
      ports: [53692, 1455]
    })
    expect(script).toContain('curl -s -m 2 --unix-socket "$sock" http://devbox/ping')
    expect(script).toContain('/dev/tcp/127.0.0.1/53692')
    expect(script).toContain('Authorization: Bearer $token')
    expect(script).toContain('\\"event\\":\\"listener\\"')
    expect(script).toContain('iterations" -lt 86400')
    expect(script).toContain('trap \'rm -f "$sock"; exit 0\' HUP TERM INT')
    expect(script).toContain('trap \'rm -f "$sock"\' EXIT')
    expect(() => execFileSync('bash', ['-n', '-c', script])).not.toThrow()
  })

  it('quotes callback URLs and provides a curl-free GET fallback', () => {
    const script = buildDevboxLoginRelayForwardScript(53692, "/callback?state=a'b")
    expect(script).toContain("--noproxy '*' 'http://127.0.0.1:53692/callback?state=a'\\''b'")
    expect(script).toContain('exec 3<>/dev/tcp/127.0.0.1/53692')
    expect(() => buildDevboxLoginRelayForwardScript(53692, 'bad url')).toThrow('Invalid login relay URL')
  })
})

describe('login relay remote parsing and configuration', () => {
  it('accepts one absolute prepare output line and rejects unsafe output', () => {
    expect(parseDevboxLoginRelayPrepareOutput('/tmp/devbox-relay\n')).toBe('/tmp/devbox-relay')
    expect(() => parseDevboxLoginRelayPrepareOutput('/tmp/a\n/tmp/b\n')).toThrow('invalid directory')
    expect(() => parseDevboxLoginRelayPrepareOutput('tmp/devbox-relay\n')).toThrow('invalid directory')
  })

  it('parses status, content type, CRLF, and body while ignoring other headers', () => {
    expect(parseDevboxRawHttpResponse('HTTP/1.1 302 Found\r\nLocation: /callback\r\nContent-Type: text/html\r\nConnection: close\r\n\r\nhello')).toEqual({
      statusCode: 302,
      contentType: 'text/html',
      body: 'hello'
    })
    expect(parseDevboxRawHttpResponse('HTTP/1.0 204 No Content\nX-Test: yes\n\n')).toEqual({ statusCode: 204, body: '' })
  })

  it('resolves defaults, validates overrides, and honours the opt-out', () => {
    expect(resolveDevboxLoginRelayPorts({})).toEqual([53692, 1455, 1456])
    expect(resolveDevboxLoginRelayPorts({ DEVBOX_LOGIN_RELAY_PORTS: '4000, 4001,4000' })).toEqual([4000, 4001])
    expect(() => resolveDevboxLoginRelayPorts({ DEVBOX_LOGIN_RELAY_PORTS: '80' })).toThrow('1024')
    expect(isDevboxLoginRelayEnabled({}, false)).toBe(true)
    expect(isDevboxLoginRelayEnabled({ DEVBOX_SHELL_LOGIN_RELAY: '0' }, false)).toBe(false)
    expect(isDevboxLoginRelayEnabled({}, true)).toBe(false)
  })
})
