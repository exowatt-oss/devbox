import { describe, expect, it, vi } from 'vitest'
import {
  buildAttachMarker,
  buildDetachMarker,
  buildStateMarker,
  detachReasonForExitCode,
  writeTerminalMarker,
  type TerminalMarkerAttachInput,
  type TerminalMarkerStream
} from './shell-terminal-marker'

const attachInput: TerminalMarkerAttachInput = {
  profileId: 'roam',
  sessionId: 2,
  sessionName: 'devbox-roam-2-emufix',
  friendlyName: 'emufix',
  host: '203.0.113.10',
  port: 22,
  username: 'sample',
  remoteCwd: '/home/sample/project',
  program: 'phi',
  tmuxSocket: 'devbox-01ff033d051e',
  cliVersion: '0.2.15'
}

function stream(isTTY = true): { stream: TerminalMarkerStream; writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    stream: { isTTY, write: vi.fn((chunk: string) => { writes.push(chunk); return true }) }
  }
}

describe('terminal host integration marker', () => {
  it('builds the byte-exact attach JSON payload', () => {
    expect(buildAttachMarker(attachInput)).toBe(
      '{"v":1,"event":"attach","profileId":"roam","sessionId":2,"sessionName":"devbox-roam-2-emufix","friendlyName":"emufix","host":"203.0.113.10","port":22,"username":"sample","remoteCwd":"/home/sample/project","program":"phi","tmuxSocket":"devbox-01ff033d051e","cliVersion":"0.2.15"}'
    )
  })

  it('builds a detach payload with only the stable identity fields', () => {
    expect(buildDetachMarker({ profileId: 'roam', sessionName: 'devbox-roam-2-emufix' })).toBe(
      '{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-2-emufix"}'
    )
  })

  it('writes the OSC frame only for a TTY and preserves its exact wire bytes', () => {
    const output = stream()
    expect(writeTerminalMarker(output.stream, buildAttachMarker(attachInput), {})).toBe(true)
    expect(output.writes).toEqual([
      '\u001b]9998;devbox-terminal;{"v":1,"event":"attach","profileId":"roam","sessionId":2,"sessionName":"devbox-roam-2-emufix","friendlyName":"emufix","host":"203.0.113.10","port":22,"username":"sample","remoteCwd":"/home/sample/project","program":"phi","tmuxSocket":"devbox-01ff033d051e","cliVersion":"0.2.15"}\u0007'
    ])
    expect(Buffer.byteLength(output.writes[0]!, 'utf8')).toBeGreaterThan(0)
  })

  it('gates non-TTY output and the explicit opt-out', () => {
    const nonTty = stream(false)
    const optedOut = stream()
    const marker = buildDetachMarker({ profileId: 'roam', sessionName: 'devbox-roam-2-emufix' })
    expect(writeTerminalMarker(nonTty.stream, marker, {})).toBe(false)
    expect(writeTerminalMarker(optedOut.stream, marker, { DEVBOX_TERMINAL_MARKERS: '0' })).toBe(false)
    expect(nonTty.writes).toEqual([])
    expect(optedOut.writes).toEqual([])
  })

  it.each([
    ['profileId', { profileId: 'Roam' }],
    ['sessionName', { sessionName: 'devbox-roam-2' }],
    ['sessionId', { sessionId: 0 }],
    ['friendlyName', { friendlyName: 'bad/name' }],
    ['host', { host: 'bad host' }],
    ['port', { port: 65_536 }],
    ['username', { username: 'bad user' }],
    ['remoteCwd', { remoteCwd: 'relative/path' }],
    ['program', { program: 'node' as 'shell' }],
    ['control character', { host: 'host\u001bname' }]
  ])('rejects invalid %s fields', (_field, override) => {
    expect(() => buildAttachMarker({ ...attachInput, ...override })).toThrow('terminal marker')
  })

  it('rejects a friendly name that does not match the canonical session', () => {
    expect(() => buildAttachMarker({ ...attachInput, friendlyName: 'other' })).toThrow('friendlyName')
  })

  it('rejects oversized serialized JSON before writing', () => {
    expect(() => buildAttachMarker({ ...attachInput, cliVersion: 'x'.repeat(2_050) })).toThrow('2048 bytes')
  })

  it('rejects control characters before JSON escaping can hide them', () => {
    expect(() => buildAttachMarker({ ...attachInput, cliVersion: '0.2.15\u0007' })).toThrow('control character')
  })

  it('adds the detach reason and exit code after the identity (CLI 0.6.9)', () => {
    const identity = { profileId: 'roam', sessionName: 'devbox-roam-2-emufix' }
    expect(buildDetachMarker({ ...identity, reason: 'connection-lost', exitCode: 255 })).toBe(
      '{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-2-emufix","reason":"connection-lost","exitCode":255}'
    )
    expect(buildDetachMarker({ ...identity, reason: 'error' })).toBe(
      '{"v":1,"event":"detach","profileId":"roam","sessionName":"devbox-roam-2-emufix","reason":"error"}'
    )
    expect(() => buildDetachMarker({ ...identity, reason: 'gone' as 'exit' })).toThrow('reason')
    expect(() => buildDetachMarker({ ...identity, exitCode: 1.5 })).toThrow('exitCode')
  })

  it('maps exit codes to reasons: 0 exit, retried 255 connection-lost, everything else error', () => {
    expect(detachReasonForExitCode(0, true)).toBe('exit')
    expect(detachReasonForExitCode(0, false)).toBe('exit')
    expect(detachReasonForExitCode(255, true)).toBe('connection-lost')
    expect(detachReasonForExitCode(255, false)).toBe('error')
    expect(detachReasonForExitCode(1, true)).toBe('error')
    expect(detachReasonForExitCode(130, true)).toBe('error')
  })

  it('builds the reconnecting state marker', () => {
    expect(buildStateMarker({ profileId: 'roam', sessionName: 'devbox-roam-2-emufix', state: 'reconnecting', attempt: 2, retryInMs: 2_000 })).toBe(
      '{"v":1,"event":"state","profileId":"roam","sessionName":"devbox-roam-2-emufix","state":"reconnecting","attempt":2,"retryInMs":2000}'
    )
    expect(buildStateMarker({ profileId: 'roam', sessionName: 'devbox-roam-2', state: 'reconnecting' })).toBe(
      '{"v":1,"event":"state","profileId":"roam","sessionName":"devbox-roam-2","state":"reconnecting"}'
    )
  })

  it.each([
    ['attempt', { attempt: 0 }],
    ['attempt', { attempt: 1.5 }],
    ['retryInMs', { retryInMs: -1 }],
    ['retryInMs', { retryInMs: 0.5 }],
    ['state', { state: 'attached' as 'reconnecting' }],
    ['sessionName', { sessionName: 'devbox-other-2' }]
  ])('rejects an invalid state marker %s', (field, override) => {
    expect(() => buildStateMarker({ profileId: 'roam', sessionName: 'devbox-roam-2', state: 'reconnecting', ...override })).toThrow(field === 'sessionName' ? 'canonical' : field)
  })
})
