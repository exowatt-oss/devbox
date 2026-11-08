import { describe, expect, it } from 'vitest'
import { DevboxPathMapper } from '../devbox-path-mapper'
import {
  DevboxGitReconciler,
  type DevboxGitReconcileInput,
  type DevboxGitReconcilerCommand
} from './devbox-git-reconciler'
import type { DevboxAuthorityEpochRecord, DevboxProfileV1 } from '../../shared/devbox-types'

const oid = 'a'.repeat(40)
const otherOid = 'b'.repeat(40)
const receiverOid = 'c'.repeat(40)
const epoch = {
  epoch: 'epoch-reconcile' as DevboxAuthorityEpochRecord['epoch'],
  sequence: 3,
  owner: 'remote',
  observedAt: 20,
  committedAt: 21
} satisfies DevboxAuthorityEpochRecord
const profile: DevboxProfileV1 = {
  schemaVersion: 1,
  id: 'profile',
  displayName: 'test',
  sshTarget: {
    targetId: 'target',
    identity: { host: 'fake', port: 22, username: 'test', hostKeyFingerprint: 'sha256:fake' }
  },
  roots: { localRoot: '/local', remoteRoot: '/remote' },
  pathMap: [],
  toolchain: { lockId: 'toolchain', lockSha256: 'a'.repeat(64) },
  sync: {
    defaultClassId: 'portable',
    excludes: [],
    classes: [
      {
        id: 'portable',
        kind: 'portable-working',
        backend: 'mutagen',
        mode: 'two-way-safe',
        excludes: []
      }
    ]
  },
  credentials: [],
  defaultAuthority: 'remote',
  projectDefaults: { remoteTerminals: true, remoteAgents: true, remoteAutomations: true },
  featureDefaults: { detachedJobs: true, closedSessionHistory: true },
  slo: {
    syncLagTargetMs: 1,
    reconnectTargetMs: 1,
    operationRecoveryTargetMs: 1,
    offlineEdits: 'warn'
  }
}

class GitFake {
  readonly commands: DevboxGitReconcilerCommand[] = []

  async run(command: DevboxGitReconcilerCommand) {
    this.commands.push(command)
    return { exitCode: 0 }
  }
}

class FilesFake {
  readonly writes: { path: string; mode: number }[] = []

  async write(path: string, _contents: string | Uint8Array, mode: number) {
    this.writes.push({ path, mode })
  }
}

function baseInput(overrides: Partial<DevboxGitReconcileInput> = {}): DevboxGitReconcileInput {
  return {
    profileId: 'profile',
    repositoryId: 'repo',
    operationId: 'operation',
    sourcePath: '/local/project',
    receiverPath: '/remote/project',
    transferPath: '/fake/shadow.git',
    authority: 'verified',
    authorityEpoch: epoch,
    pathMapper: new DevboxPathMapper(profile),
    sourceRefs: [
      { name: 'refs/heads/main', objectId: oid },
      { name: 'refs/notes/review', objectId: otherOid }
    ],
    receiverRefs: [{ name: 'refs/heads/receiver-only', objectId: receiverOid }],
    sourceHead: 'refs/heads/main',
    sourceConfig: [{ key: 'core.repositoryformatversion', value: '0' }],
    receiverConfig: [],
    sourceWorktrees: [{ id: 'worktree', path: '/local/project', head: oid }],
    index: [
      {
        path: 'src/main.ts',
        mode: '100644',
        objectId: oid,
        assumeUnchanged: true,
        skipWorktree: true
      }
    ],
    untrackedPaths: ['/local/project/README.md'],
    recoveryFiles: [
      {
        path: '.git/hooks/pre-commit',
        contents: '#!/bin/sh\nexit 0\n',
        mode: 0o755,
        executable: true,
        kind: 'hook'
      },
      {
        path: '.git/info/template',
        contents: 'template',
        mode: 0o644,
        executable: false,
        kind: 'template'
      }
    ],
    objectState: {
      reachable: true,
      lfsSelfContained: true,
      promisedObjectsSelfContained: true,
      alternatesSelfContained: true
    },
    projectTrust: 'not-approved',
    checkpoints: { source: '/fake/source-checkpoint', receiver: '/fake/receiver-checkpoint' },
    ...overrides
  }
}

describe('DevboxGitReconciler', () => {
  it('reconstructs through additive Git commands and preserves hook bytes inactive', async () => {
    const git = new GitFake()
    const files = new FilesFake()
    const phases: string[] = []
    const result = await new DevboxGitReconciler({
      git,
      files,
      checkpoints: {
        checkpoint: async ({ phase }) => {
          phases.push(phase)
          return { source: `/fake/${phase}-source`, receiver: `/fake/${phase}-receiver` }
        }
      }
    }).reconcile(baseInput())

    expect(result.status).toBe('reconciled')
    if (result.status !== 'reconciled') {
      return
    }
    expect(phases).toEqual(['before', 'after'])
    expect(result.hookActivation).toBe('preserved-inactive')
    expect(result.receiverOnlyRefs).toEqual([
      { name: 'refs/heads/receiver-only', objectId: receiverOid }
    ])
    expect(result.proof.worktrees[0]?.path).toBe('/remote/project')
    expect(
      files.writes.some((write) => write.path === '/remote/project/.git/hooks/pre-commit')
    ).toBe(false)
    expect(git.commands.some((command) => command.args.some((arg) => arg === 'reset'))).toBe(false)
  })

  it('blocks ambiguous authority before Git mutation and names both checkpoints', async () => {
    const git = new GitFake()
    const result = await new DevboxGitReconciler({ git, files: new FilesFake() }).reconcile(
      baseInput({ authority: 'ambiguous' })
    )

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') {
      return
    }
    expect(result.stateType).toBe('ambiguous-authority')
    expect(result.path).toBe('authority')
    expect(result.checkpoints).toEqual(baseInput().checkpoints)
    expect(git.commands).toHaveLength(0)
  })

  it('preserves receiver divergence and fails before an additive fetch', async () => {
    const git = new GitFake()
    const result = await new DevboxGitReconciler({ git, files: new FilesFake() }).reconcile(
      baseInput({
        receiverRefs: [{ name: 'refs/heads/main', objectId: receiverOid }]
      })
    )

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') {
      return
    }
    expect(result.stateType).toBe('receiver-ref-divergence')
    expect(result.path).toBe('/remote/project/refs/heads/main')
    expect(git.commands).toHaveLength(0)
  })

  it('blocks host-specific alternates and unreachable objects with remediation', async () => {
    const result = await new DevboxGitReconciler({
      git: new GitFake(),
      files: new FilesFake()
    }).reconcile(
      baseInput({
        objectState: {
          reachable: false,
          missingObjectIds: [otherOid],
          lfsSelfContained: true,
          promisedObjectsSelfContained: true,
          alternatesSelfContained: false,
          alternatePaths: ['/local/project/.git/objects/info/alternates']
        }
      })
    )

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') {
      return
    }
    expect(result.stateType).toBe('unreachable-git-objects')
    expect(result.path).toBe('/local/project/objects')
    expect(result.remediation).toContain('named objects')
  })

  it('blocks unresolved index stages before reconstructing the receiver', async () => {
    const git = new GitFake()
    const result = await new DevboxGitReconciler({ git, files: new FilesFake() }).reconcile(
      baseInput({ index: [{ path: 'conflict.ts', mode: '100644', objectId: oid, stage: 1 }] })
    )

    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') {
      return
    }
    expect(result.stateType).toBe('unresolved-index-conflict')
    expect(result.path).toBe('conflict.ts')
    expect(git.commands).toHaveLength(0)
  })
})
