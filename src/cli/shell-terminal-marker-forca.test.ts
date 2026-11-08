/**
 * Every marker this CLI emits, framed exactly as written to the terminal, parsed by copies of
 * Forca's grammar: the current one must accept each field as sent, and the pre-0.6.9 one
 * (Forca older releases) must see nothing new (state ignored, new detach keys dropped).
 */
import { describe, expect, it, vi } from 'vitest'
import { parseForcaMarkerPayload } from './__fixtures__/forca-marker-grammar'
import { parseLegacyForcaMarkerPayload } from './__fixtures__/forca-legacy-marker-grammar'
import {
  buildAttachMarker,
  buildDetachMarker,
  buildStateMarker,
  writeTerminalMarker,
  type TerminalMarkerAttachInput
} from './shell-terminal-marker'

const PREFIX = '\u001b]9998;devbox-terminal;'
const SUFFIX = '\u0007'

const attach: TerminalMarkerAttachInput = {
  profileId: 'devbox',
  sessionId: 4,
  sessionName: 'devbox-devbox-4-research',
  friendlyName: 'research',
  host: 'devbox',
  port: 22,
  username: 'sample',
  remoteCwd: '/home/sample/project',
  program: 'phi',
  tmuxSocket: 'devbox-2ff8ddd61f5e',
  cliVersion: '0.6.9'
}
const identity = { profileId: attach.profileId, sessionName: attach.sessionName }

/** Write through the real framing and return the payload Forca's scanner hands its parser. */
function framedPayload(marker: string): string {
  const writes: string[] = []
  const stream = { isTTY: true, write: vi.fn((chunk: string) => { writes.push(chunk); return true }) }
  expect(writeTerminalMarker(stream, marker, {})).toBe(true)
  const frame = writes[0]!
  expect(frame.startsWith(PREFIX) && frame.endsWith(SUFFIX)).toBe(true)
  const payload = frame.slice(PREFIX.length, -SUFFIX.length)
  expect(payload.includes('\u0007') || payload.includes('\u001b')).toBe(false)
  return payload
}

const emitted: [string, string][] = [
  ['full attach', buildAttachMarker(attach)],
  ['minimal attach (legacy socket, unnamed)', buildAttachMarker({
    profileId: 'my-box',
    sessionId: 12,
    sessionName: 'devbox-my-box-12',
    host: 'my_box',
    port: 2222,
    username: 'dev',
    program: 'shell',
    cliVersion: '0.6.9'
  })],
  ['detach exit', buildDetachMarker({ ...identity, reason: 'exit', exitCode: 0 })],
  ['detach connection-lost', buildDetachMarker({ ...identity, reason: 'connection-lost', exitCode: 255 })],
  ['detach error', buildDetachMarker({ ...identity, reason: 'error', exitCode: 130 })],
  ['detach error (spawn failed, no exit code)', buildDetachMarker({ ...identity, reason: 'error' })],
  ['detach abandoned reconnect', buildDetachMarker({ ...identity, reason: 'exit', exitCode: 255 })],
  ['state reconnecting', buildStateMarker({ ...identity, state: 'reconnecting', attempt: 3, retryInMs: 4_000 })]
]

describe('CLI markers against the Forca grammar', () => {
  it.each(emitted)('current Forca accepts the %s marker field for field', (_label, marker) => {
    const payload = framedPayload(marker)
    expect(parseForcaMarkerPayload(payload)).toEqual(JSON.parse(payload))
  })

  it('current Forca drops (never rejects) a remote cwd it cannot show', () => {
    const payload = framedPayload(buildAttachMarker({ ...attach, remoteCwd: '/home/sample/my repo' }))
    const { remoteCwd: _dropped, ...rest } = JSON.parse(payload) as Record<string, unknown>
    expect(parseForcaMarkerPayload(payload)).toEqual(rest)
  })

  it('pre-0.6.9 Forca (older releases) ignores state events and the new detach keys', () => {
    const parsed = emitted.map(([label, marker]) => [label, parseLegacyForcaMarkerPayload(framedPayload(marker))])
    expect(parsed).toEqual([
      ['full attach', JSON.parse(buildAttachMarker(attach))],
      // Its stricter hostname grammar rejects an ssh alias with `_`, as it always has.
      ['minimal attach (legacy socket, unnamed)', null],
      ...emitted.slice(2, 7).map(([label]) => [label, { v: 1, event: 'detach', ...identity }]),
      ['state reconnecting', null]
    ])
  })
})
