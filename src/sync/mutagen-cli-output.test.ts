import { describe, expect, it } from 'vitest'
import { parseMutagenMonitorOutput, parseMutagenSessionArray } from './mutagen-cli-output'

const baseSession = {
  identifier: 'session-true-model',
  name: 'devbox {working} "quoted"',
  labels: {
    'devbox-profile': 'profile-one',
    'devbox-session': 'session-one',
    'devbox-root-class': 'working',
    'devbox-backend': 'mutagen',
    note: 'braces {inside} and an escaped \\"quote\\"'
  },
  paused: false,
  status: 'watching',
  successfulCycles: 17,
  watch: { mode: 'portable', pollingInterval: 10 },
  conflicts: []
}

const realCapturedSessionPayload = `[
  {
    "identifier": "sync_52InJM1zbBMsmFvby2VrjbfwmNJ264eJHzRHnTLlbgr",
    "version": 1,
    "creationTime": "2026-08-29T15:49:56.784250466Z",
    "creatingVersion": "0.18.1",
    "alpha": {
      "protocol": "local",
      "path": "/tmp/a",
      "ignore": {},
      "symlink": {},
      "watch": {},
      "permissions": {},
      "compression": {},
      "connected": true,
      "scanned": true,
      "directories": 1
    },
    "beta": {
      "protocol": "local",
      "path": "/tmp/b",
      "ignore": {},
      "symlink": {},
      "watch": {},
      "permissions": {},
      "compression": {},
      "connected": true,
      "scanned": true,
      "directories": 1
    },
    "ignore": {},
    "symlink": {},
    "watch": {
      "mode": "portable",
      "pollingInterval": 10
    },
    "permissions": {},
    "compression": {},
    "paused": false,
    "status": "watching",
    "successfulCycles": 1
  }
]`

describe('Mutagen CLI output', () => {
  it('parses the live v0.18.1 nested session-level watch payload', () => {
    const [session] = parseMutagenSessionArray(realCapturedSessionPayload)

    expect(session).toMatchObject({
      identifier: 'sync_52InJM1zbBMsmFvby2VrjbfwmNJ264eJHzRHnTLlbgr',
      watch: { mode: 'portable', pollingInterval: 10, native: null },
      lastChangeAt: null,
      lastSynchronizedAt: null
    })
  })

  it('preserves a non-default nested session watch configuration', () => {
    const [session] = parseMutagenSessionArray(
      JSON.stringify([
        {
          ...baseSession,
          identifier: 'session-force-poll',
          watch: { mode: 'force-poll', pollingInterval: 3 }
        }
      ])
    )

    expect(session?.watch).toEqual({ mode: 'force-poll', pollingInterval: 3, native: null })
  })

  it('defaults missing and empty session-level watch objects safely', () => {
    const [missingWatch, emptyWatch] = parseMutagenSessionArray(
      JSON.stringify([
        { ...baseSession, identifier: 'session-missing-watch', watch: undefined },
        { ...baseSession, identifier: 'session-empty-watch', watch: {} }
      ])
    )

    expect(missingWatch?.watch).toEqual({ mode: 'portable', pollingInterval: null, native: null })
    expect(emptyWatch?.watch).toEqual({ mode: 'portable', pollingInterval: null, native: null })
  })

  it('handles malformed watch values without throwing', () => {
    const [invalidWatch, invalidPollingInterval] = parseMutagenSessionArray(
      JSON.stringify([
        { ...baseSession, identifier: 'session-invalid-watch', watch: 'nope' },
        {
          ...baseSession,
          identifier: 'session-invalid-polling-interval',
          watch: { mode: 'force-poll', pollingInterval: 'ten' }
        }
      ])
    )

    expect(invalidWatch?.watch).toEqual({ mode: 'portable', pollingInterval: null, native: null })
    expect(invalidPollingInterval?.watch).toEqual({
      mode: 'force-poll',
      pollingInterval: null,
      native: null
    })
  })

  it('frames concatenated monitor arrays when strings contain braces and escapes', () => {
    const firstFrame = JSON.stringify([baseSession])
    const secondFrame = JSON.stringify([
      { ...baseSession, identifier: 'session-second', successfulCycles: 18 }
    ])

    const frames = parseMutagenMonitorOutput(`${firstFrame}${secondFrame}`)

    expect(frames).toHaveLength(2)
    expect(frames[0]?.[0]?.name).toBe('devbox {working} "quoted"')
    expect(frames[1]?.[0]?.successfulCycles).toBe(18)
  })

  it('reads Mutagen lastError and problems alongside conflicts', () => {
    const [session] = parseMutagenSessionArray(JSON.stringify([{
      ...baseSession,
      lastError: 'beta scan error: remote error: exceeded allowed entry count',
      problems: ['scan failed', { path: 'beta', error: 'permission denied' }],
      conflicts: [{
        root: 'src/config.json',
        alphaChanges: [{ path: 'src/config.json', new: { kind: 'file', digest: 'a' } }],
        betaChanges: [{ path: 'src/config.json', new: { kind: 'file', digest: 'b' } }]
      }]
    }]))
    expect(session).toMatchObject({
      lastError: 'beta scan error: remote error: exceeded allowed entry count',
      problems: ['scan failed', '{"path":"beta","error":"permission denied"}'],
      conflicts: [{ path: 'src/config.json' }]
    })
  })

  it('normalizes v0.18.1 conflict roots and alpha/beta change trees', () => {
    const payload = {
      ...baseSession,
      identifier: 'session-with-conflict',
      conflicts: [
        {
          root: 'src/config.json',
          alphaChanges: [
            {
              path: 'src/config.json',
              old: { kind: 'file', digest: 'base-digest' },
              new: { kind: 'file', digest: 'alpha-digest' }
            }
          ],
          betaChanges: [
            {
              path: 'src/config.json',
              old: { kind: 'file', digest: 'base-digest' },
              new: { kind: 'file', digest: 'beta-digest' }
            }
          ]
        }
      ]
    }

    const [session] = parseMutagenSessionArray(JSON.stringify([payload]))

    expect(session?.conflicts).toEqual([
      {
        path: 'src/config.json',
        alpha: { kind: 'file', hash: 'alpha-digest' },
        beta: { kind: 'file', hash: 'beta-digest' }
      }
    ])
  })
})
