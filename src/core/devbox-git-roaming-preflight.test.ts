import { describe, expect, it } from 'vitest'
import { classifyGitRoamingPreflightFindings } from './devbox-git-roaming-preflight'
import type { DevboxGitRoamingBlocker } from './authority/devbox-git-roaming-types'

const finding = (code: DevboxGitRoamingBlocker['code']): DevboxGitRoamingBlocker => ({ code, repository: 'repo', message: `${code} evidence` })

describe('Git-roaming preflight classification', () => {
  it('keeps pair-time blockers narrow and makes handoff findings informational', () => {
    const classified = classifyGitRoamingPreflightFindings([
      finding('dirty-repository'),
      finding('missing-origin-publication'),
      finding('linked-worktree'),
      finding('root-mismatch'),
      finding('park-failed')
    ])
    expect(classified.blockers.map(({ code }) => code)).toEqual(['root-mismatch', 'park-failed'])
    expect(classified.informational.map(({ code }) => code)).toEqual(['dirty-repository', 'missing-origin-publication', 'linked-worktree'])
    expect(classified.warnings).toHaveLength(3)
    expect(classified.warnings[0]).toMatchObject({ repository: 'repo', code: 'handoff-required' })
  })
})
