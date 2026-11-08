import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  DevboxMutagenSshConfig,
  type DevboxMutagenApprovedHostKey,
  type DevboxMutagenSshConfigMaterial,
  type DevboxMutagenSshMaterialRequest
} from '../../sync/devbox-mutagen-ssh-config'
import {
  MutagenCli,
  type MutagenCommandResult,
  type MutagenCommandRunner
} from '../../sync/mutagen-cli'
import { MutagenSyncBackend } from '../../sync/mutagen-sync-backend'
import type {
  DevboxSyncBackupHandle,
  DevboxSyncConflict,
  DevboxSyncConflictStore,
  DevboxSyncCreateRequest,
  DevboxSyncSessionIdentity,
  DevboxSyncSessionStore
} from '../../sync/devbox-sync-backend'
import type { DevboxSshIdentity } from '../../shared/devbox-types'
import type { FixtureSshServer } from './ssh-server'

export type BackendFixture = {
  backend: MutagenSyncBackend
  cli: MutagenCli
  request: DevboxSyncCreateRequest
  materialRequest: DevboxMutagenSshMaterialRequest
  material: DevboxMutagenSshConfigMaterial
}

export function approvedHostKey(
  server: FixtureSshServer,
  identity: DevboxSshIdentity
): DevboxMutagenApprovedHostKey {
  const [algorithm, publicKey] = server.hostKey.publicKey.split(' ')
  if (!algorithm || !publicKey) {
    throw new Error('fixture host key did not have an OpenSSH public-key shape')
  }
  return {
    endpoint: identity,
    algorithm,
    publicKey,
    fingerprint: server.hostKey.fingerprint
  }
}

export function identityFor(server: FixtureSshServer): DevboxSshIdentity {
  return {
    host: server.host,
    port: server.port,
    username: 'fixture',
    hostKeyFingerprint: server.hostKey.fingerprint
  }
}

function stores(): {
  sessionStore: DevboxSyncSessionStore
  conflictStore: DevboxSyncConflictStore
} {
  const sessions: DevboxSyncSessionIdentity[] = []
  const conflicts: DevboxSyncConflict[] = []
  return {
    sessionStore: {
      list: () => sessions,
      upsert: (session) => {
        const index = sessions.findIndex((candidate) => candidate.sessionId === session.sessionId)
        if (index >= 0) {
          sessions[index] = session
        } else {
          sessions.push(session)
        }
      },
      remove: (session) => {
        const index = sessions.findIndex((candidate) => candidate.sessionId === session.sessionId)
        if (index >= 0) {
          sessions.splice(index, 1)
        }
      }
    },
    conflictStore: {
      list: () => conflicts,
      remove: (conflictId) => {
        const index = conflicts.findIndex((conflict) => conflict.conflictId === conflictId)
        if (index >= 0) {
          conflicts.splice(index, 1)
        }
      }
    }
  }
}

function backupStore() {
  const backups = new Set<string>()
  return {
    create: async (conflict: DevboxSyncConflict): Promise<DevboxSyncBackupHandle> => {
      const handle = {
        id: `fixture-backup-${conflict.conflictId}`,
        conflictId: conflict.conflictId,
        localHash: conflict.local.hash,
        remoteHash: conflict.remote.hash,
        createdAt: Date.now()
      }
      backups.add(handle.id)
      return handle
    },
    has: async (handle: DevboxSyncBackupHandle) => backups.has(handle.id)
  }
}

export function createBackendFixture(
  rootDirectory: string,
  binaryPath: string,
  material: DevboxMutagenSshConfigMaterial,
  materialRequest: DevboxMutagenSshMaterialRequest,
  request: DevboxSyncCreateRequest
): BackendFixture {
  const appDataRoot = join(rootDirectory, 'app-data')
  const dataDirectory = join(appDataRoot, 'mutagen')
  const localRoot = request.localRoot
  mkdirSync(localRoot, { recursive: true })
  writeFileSync(join(localRoot, 'transport-sentinel.txt'), 'fixture-sentinel\n')
  const cli = new MutagenCli({
    binaryPath,
    appDataRoot,
    dataDirectory,
    profileId: request.profileId,
    sshPath: material.wrapperDirectory
  })
  const { sessionStore, conflictStore } = stores()
  const backend = new MutagenSyncBackend({
    profileId: request.profileId,
    cli,
    sessionStore,
    conflictStore,
    backupStore: backupStore(),
    transportIdentity: { isCurrent: () => material.isCurrent(materialRequest) },
    remoteEndpoint: (current) => material.remoteEndpoint(current.remoteRoot)
  })
  return { backend, cli, request, materialRequest, material }
}

export const boundedMonitorRunner: MutagenCommandRunner = async (
  command,
  args,
  options
): Promise<MutagenCommandResult> => {
  const child = spawn(command, [...args], {
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: options.signal
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  return await new Promise<MutagenCommandResult>((resolve, reject) => {
    const finish = (result: MutagenCommandResult): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), 3_500)
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (options.signal?.aborted) {
        finish({ exitCode: 130, stdout, stderr })
      } else {
        reject(error)
      }
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish({ exitCode: 0, stdout, stderr })
    })
  })
}

export function createSshConfig(
  rootDirectory: string,
  server: FixtureSshServer,
  profileId: string,
  proxyJump: DevboxMutagenSshMaterialRequest['proxyJump'] = []
): {
  config: DevboxMutagenSshConfig
  material: DevboxMutagenSshConfigMaterial
  request: DevboxMutagenSshMaterialRequest
} {
  const identity = identityFor(server)
  const request: DevboxMutagenSshMaterialRequest = {
    profileId,
    identity,
    approvedHostKey: approvedHostKey(server, identity),
    proxyJump
  }
  const config = new DevboxMutagenSshConfig({
    stateDirectory: join(rootDirectory, 'state'),
    sshBinary: server.sshBinaryPath,
    scpBinary: server.scpBinaryPath
  })
  return { config, material: config.materialize(request), request }
}

export function createProxyJump(
  server: FixtureSshServer,
  hop: FixtureSshServer,
  profileId: string,
  rootDirectory: string
): {
  config: DevboxMutagenSshConfig
  material: DevboxMutagenSshConfigMaterial
  request: DevboxMutagenSshMaterialRequest
} {
  const finalIdentity = identityFor(server)
  const hopIdentity = identityFor(hop)
  const hopRequest: DevboxMutagenSshMaterialRequest = {
    profileId,
    identity: hopIdentity,
    approvedHostKey: approvedHostKey(hop, hopIdentity)
  }
  const finalRequest: DevboxMutagenSshMaterialRequest = {
    profileId,
    identity: finalIdentity,
    approvedHostKey: approvedHostKey(server, finalIdentity),
    proxyJump: [
      {
        identity: hopIdentity,
        approvedHostKey: hopRequest.approvedHostKey
      }
    ]
  }
  const config = new DevboxMutagenSshConfig({
    stateDirectory: join(rootDirectory, 'state'),
    sshBinary: server.sshBinaryPath,
    scpBinary: server.scpBinaryPath
  })
  return { config, material: config.materialize(finalRequest), request: finalRequest }
}
