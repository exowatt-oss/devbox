import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DevboxProfileConfigStore } from '../core/devbox-profile-config'
import { CliArgumentError } from './args'
import { generateDevboxJobId } from './handlers'
import { normalizeProfileSelectionFlags, resolveDevboxProfile } from './profile-resolution'
import type { DevboxProfileV1 } from '../shared/devbox-types'

const profile = (id: string): DevboxProfileV1 => ({ id } as DevboxProfileV1)

const profiles = [profile('alpha'), profile('bravo')]

describe('CLI profile resolution', () => {
  it('uses explicit --profile before environment, config, and single-profile fallback', () => {
    const selection = resolveDevboxProfile(new Map([['profile', 'alpha']]), {
      profiles,
      env: { DEVBOX_PROFILE: 'bravo' },
      configuredDefault: 'bravo'
    })
    expect(selection).toMatchObject({ profileId: 'alpha', source: 'explicit' })
  })

  it('resolves --device and DEVBOX_PROFILE aliases after profile IDs', () => {
    const withAlias = [{ ...profile('project'), device: 'workstation' }, profile('other')]
    expect(resolveDevboxProfile(new Map([['device', 'workstation']]), { profiles: withAlias }).profileId).toBe('project')
    expect(resolveDevboxProfile(new Map(), { profiles: withAlias, env: { DEVBOX_PROFILE: 'workstation' } }).profileId).toBe('project')
    expect(() => resolveDevboxProfile(new Map([['profile', 'project'], ['device', 'other']]), { profiles: withAlias })).toThrow('--profile and --device differ')
  })

  it('canonicalizes --device and rejects differing selectors', () => {
    const flags = new Map<string, string | boolean>([['device', 'workstation']])
    normalizeProfileSelectionFlags(flags)
    expect(flags.get('profile')).toBe('workstation')
    expect(() => normalizeProfileSelectionFlags(new Map([['profile', 'project'], ['device', 'workstation']]))).toThrow('--profile and --device differ')
  })

  it('uses DEVBOX_PROFILE before the configured default', () => {
    const selection = resolveDevboxProfile(new Map(), {
      profiles,
      env: { DEVBOX_PROFILE: 'bravo' },
      configuredDefault: 'alpha'
    })
    expect(selection).toMatchObject({ profileId: 'bravo', source: 'environment' })
  })

  it('uses the configured default before a single-profile fallback', () => {
    const selection = resolveDevboxProfile(new Map(), {
      profiles,
      configuredDefault: 'alpha'
    })
    expect(selection).toMatchObject({ profileId: 'alpha', source: 'configured' })

    const fallback = resolveDevboxProfile(new Map(), { profiles: [profile('only')] })
    expect(fallback).toMatchObject({ profileId: 'only', source: 'single-profile' })
  })

  it('fails with available IDs and a default-setting hint when ambiguous', () => {
    expect(() => resolveDevboxProfile(new Map(), { profiles })).toThrow(
      'No profile selected. Available profiles: alpha, bravo. Set DEVBOX_PROFILE=<id> or run devbox profile use <id>.'
    )
    expect(() => resolveDevboxProfile(new Map(), {
      profiles,
      env: { DEVBOX_PROFILE: 'missing' }
    })).toThrow(
      'Devbox profile "missing" from DEVBOX_PROFILE was not found. Available profiles: alpha, bravo. Set DEVBOX_PROFILE=<id> or run devbox profile use <id>.'
    )
    try {
      resolveDevboxProfile(new Map(), { profiles })
    } catch (error) {
      expect(error).toBeInstanceOf(CliArgumentError)
      expect((error as Error).message).not.toContain('\n')
    }
  })
})

describe('profile default config', () => {
  it('round-trips a schema-versioned default and clears it', () => {
    const root = mkdtempSync(join(tmpdir(), 'devbox-config-'))
    const path = join(root, 'nested', 'config.json')
    const store = new DevboxProfileConfigStore(path)
    expect(store.getDefaultProfile()).toBeUndefined()
    store.setDefaultProfile('roam')
    expect(store.getDefaultProfile()).toBe('roam')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      defaultProfile: 'roam'
    })
    store.setDefaultProfile(undefined)
    expect(store.getDefaultProfile()).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1 })
  })
})

describe('run defaults', () => {
  it('generates readable unique IDs', () => {
    const first = generateDevboxJobId(new Date('2026-08-30T12:34:56Z'), Buffer.from('abcd', 'hex'))
    const second = generateDevboxJobId(new Date('2026-08-30T12:34:56Z'), Buffer.from('1234', 'hex'))
    expect(first).toBe('job-20260830-123456-abcd')
    expect(second).toBe('job-20260830-123456-1234')
    expect(first).not.toBe(second)
  })
})
