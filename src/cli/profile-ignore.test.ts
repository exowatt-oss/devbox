import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfile, type ScannedKey } from './profile-create'
import { addProfileIgnores, listProfileIgnores, removeProfileIgnores } from './profile-ignore'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { devboxSyncRequests } from '../core/devbox-orchestrator-actions'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const key: ScannedKey = { type: 'ssh-ed25519', blob: Buffer.from('fixture-host-key'), line: 'example.test ssh-ed25519 Zml4dHVyZS1ob3N0LWtleQ==\n' }

describe('profile Git-roaming ignore rules', () => {
  it('supports ignore CRUD for a plain profile through sync.excludes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-ignore-plain-'))
    await createProfile({ profileId: 'plain', host: 'example.test', port: 22, username: 'dev', localRoot: '/workspace', remoteRoot: '/remote/workspace', yes: true, force: false }, { profileRoot: root, env: {}, keyscan: async () => [key] })
    const added = addProfileIgnores(root, {}, 'plain', ['.env', 'cache/'])
    expect(added.patterns).toEqual([
      { pattern: '.env', rootClass: 'portable-working' },
      { pattern: 'cache/', rootClass: 'portable-working' }
    ])
    expect(listProfileIgnores(root, {}, 'plain').patterns).toEqual(added.patterns)
    expect(removeProfileIgnores(root, {}, 'plain', ['.env']).patterns).toEqual([{ pattern: 'cache/', rootClass: 'portable-working' }])
  })

  it('accepts root-anchored patterns, saves them unchanged, and rejects a bare root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-ignore-anchored-'))
    await createProfile({ profileId: 'plain', host: 'example.test', port: 22, username: 'dev', localRoot: '/workspace', remoteRoot: '/remote/workspace', yes: true, force: false }, { profileRoot: root, env: {}, keyscan: async () => [key] })
    const added = addProfileIgnores(root, {}, 'plain', ['/.data/', '/financial_archive/'])
    expect(added.patterns.map((entry) => entry.pattern)).toEqual(['/.data/', '/financial_archive/'])
    const store = new DevboxProfileStore({ rootDir: root, env: {} })
    const loaded = store.loadProfile('plain')
    expect(loaded.status).toBe('loaded')
    const profile = (loaded as { profile: DevboxProfileV1 }).profile
    expect(profile.sync.excludes).toEqual(expect.arrayContaining(['/.data/', '/financial_archive/']))
    expect(devboxSyncRequests(profile)[0]!.excludes).toEqual(expect.arrayContaining(['/.data/', '/financial_archive/']))
    for (const bad of ['/', '//x', '/../x']) {expect(() => addProfileIgnores(root, {}, 'plain', [bad])).toThrow('Invalid ignore pattern')}
  })

  it('round-trips add/list/rm and records re-pair semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-ignore-'))
    await createProfile({ profileId: 'roam', host: 'example.test', port: 22, username: 'dev', localRoot: '/workspace', remoteRoot: '/remote/workspace', yes: true, force: false, gitRoaming: true }, { profileRoot: root, env: {}, keyscan: async () => [key] })
    const added = addProfileIgnores(root, {}, 'roam', ['.env', '**/ignored/'], 'portable-working')
    expect(added.requiresRePair).toBe(true)
    expect(added.patterns).toEqual([
      { pattern: '.env', rootClass: 'portable-working' },
      { pattern: '**/ignored/', rootClass: 'portable-working' }
    ])
    const listed = listProfileIgnores(root, {}, 'roam')
    expect(listed.patterns).toEqual(added.patterns)
    const removed = removeProfileIgnores(root, {}, 'roam', ['.env'])
    expect(removed.patterns).toEqual([{ pattern: '**/ignored/', rootClass: 'portable-working' }])
  })
})
