import { describe, expect, it } from 'vitest'
import {
  DevboxGitShadow,
  type DevboxGitShadowCommand,
  type DevboxGitShadowRef
} from './devbox-git-shadow'
import type { DevboxAuthorityEpochRecord } from '../../shared/devbox-types'

const oid = 'a'.repeat(40)
const detached = 'b'.repeat(40)
const epoch = {
  epoch: 'epoch-shadow' as DevboxAuthorityEpochRecord['epoch'],
  sequence: 4,
  owner: 'local',
  observedAt: 10,
  committedAt: 11
} satisfies DevboxAuthorityEpochRecord
const refs: readonly DevboxGitShadowRef[] = [
  { name: 'refs/heads/main', objectId: oid },
  { name: 'refs/notes/review', objectId: oid }
]

class GitFake {
  readonly commands: DevboxGitShadowCommand[] = []

  async run(command: DevboxGitShadowCommand) {
    this.commands.push(command)
    if (command.args[0] === 'for-each-ref') {
      const prefix = command.args[2]
      return {
        exitCode: 0,
        stdout:
          `${prefix}heads/main ${oid}\n` +
          `${prefix}notes/review ${oid}\n` +
          `${prefix}devbox/recovery/profile-repo-operation/${detached.slice(0, 16)} ${detached}\n`
      }
    }
    return { exitCode: 0 }
  }
}

class FilesFake {
  readonly writes: { path: string; contents: string }[] = []

  async write(path: string, contents: string) {
    this.writes.push({ path, contents })
  }
}

function input() {
  return {
    profileId: 'profile',
    repositoryId: 'repo',
    operationId: 'operation',
    sourcePath: '/fake/source',
    shadowPath: '/fake/shadow.git',
    reflogPath: '/fake/reflog.json',
    authority: epoch,
    refs,
    detachedObjectIds: [detached],
    reflogRecovery: ['refs/heads/main old new user timestamp']
  }
}

describe('DevboxGitShadow', () => {
  it('keeps a local checkpoint and reports UNREPLICATED while offline', async () => {
    const git = new GitFake()
    const files = new FilesFake()
    const result = await new DevboxGitShadow({
      git,
      files,
      peer: { isReachable: async () => false, replicate: async () => ({ status: 'failed' }) }
    }).checkpoint(input())

    expect(result.status).toBe('checkpointed')
    if (result.status !== 'checkpointed') {
      return
    }
    expect(result.replication).toEqual({ status: 'UNREPLICATED', attempts: 0 })
    expect(result.checkpoint.refs).toEqual(refs)
    expect(result.checkpoint.detachedObjectIds).toEqual([detached])
    expect(files.writes).toHaveLength(1)
    expect(git.commands.some((command) => command.args.includes('--force'))).toBe(false)
  })

  it('replicates and verifies all refs after at most two transient retries', async () => {
    const git = new GitFake()
    const files = new FilesFake()
    let attempts = 0
    const result = await new DevboxGitShadow({
      git,
      files,
      peer: {
        isReachable: async () => true,
        replicate: async (request) => {
          attempts += 1
          if (attempts === 1) {
            return { status: 'failed' as const }
          }
          return {
            status: 'replicated' as const,
            receiverCheckpointPath: '/fake/receiver/checkpoint',
            receivedRefs: [
              {
                name: `${request.checkpoint.refPrefix}heads/main`,
                objectId: oid
              },
              {
                name: `${request.checkpoint.refPrefix}notes/review`,
                objectId: oid
              }
            ],
            receivedObjectIds: [detached],
            receivedManifestDigest: request.checkpoint.manifestDigest
          }
        }
      }
    }).checkpoint(input())

    expect(result.status).toBe('checkpointed')
    if (result.status !== 'checkpointed') {
      return
    }
    expect(result.replication.status).toBe('REPLICATED')
    expect(result.replication.attempts).toBe(2)
    expect(result.replication.receiverCheckpointPath).toBe('/fake/receiver/checkpoint')
  })

  it('fails closed when the receiver verification does not match', async () => {
    const git = new GitFake()
    const result = await new DevboxGitShadow({
      git,
      files: new FilesFake(),
      peer: {
        isReachable: async () => true,
        replicate: async () => ({
          status: 'replicated' as const,
          receiverCheckpointPath: '/fake/receiver/checkpoint',
          receivedRefs: [],
          receivedObjectIds: []
        })
      }
    }).checkpoint(input())

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') {
      return
    }
    expect(result.stateType).toBe('peer-verification-mismatch')
    expect(result.checkpoint).not.toBeNull()
    expect(result.receiverCheckpointPath).toBe('/fake/receiver/checkpoint')
    expect(result.remediation).toContain('both checkpoints')
  })
})
