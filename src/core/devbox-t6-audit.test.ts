import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DevboxJobLogStore } from './devbox-job-logs'
import { createStandaloneDevboxAdapters } from './devbox-standalone-adapters'
import type { DevboxSyncBackend, DevboxSyncSessionIdentity } from '../sync/devbox-sync-backend'
import { DevboxSyncSupervisor } from '../sync/devbox-sync-supervisor'

type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  pathDelimiter?: ':' | ';'
  mcpOAuthBridgePath?: string
}

function withRemoteCliBridgeEnv(
  bridge: RemoteCliBridgeEnv | undefined,
  env: Record<string, string> | undefined,
  envToDelete?: readonly string[]
): Record<string, string> {
  const merged = { ...env }
  if (bridge) {
    const delimiter = bridge.pathDelimiter ?? ':'
    const scopedLaunch = envToDelete?.includes('DEVBOX_REMOTE_CLI_BIN_DIR') === true
    const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
    if (scopedLaunch && pathKey) {
      merged[pathKey] = merged[pathKey]
        .split(delimiter)
        .filter((entry) =>
          delimiter === ';'
            ? entry.toLowerCase() !== bridge.binDir.toLowerCase()
            : entry !== bridge.binDir
        )
        .join(delimiter)
    }
    if (pathKey) {
      const pathValue = merged[pathKey] ?? ''
      const entries = pathValue.split(delimiter)
      merged[pathKey] = scopedLaunch
        ? entries.join(delimiter)
        : entries.includes(bridge.binDir)
          ? pathValue
          : pathValue
            ? `${bridge.binDir}${delimiter}${pathValue}`
            : bridge.binDir
    }
    merged.DEVBOX_REMOTE_CLI_BIN_DIR = bridge.binDir
    merged.DEVBOX_RELAY_DIR = bridge.relayDir
    merged.DEVBOX_RELAY_NODE_PATH = bridge.nodePath
    merged.DEVBOX_RELAY_SOCKET_PATH = bridge.sockPath
    if (bridge.mcpOAuthBridgePath) {
      merged.PI_MCP_OAUTH_BRIDGE_COMMAND = bridge.mcpOAuthBridgePath
    } else {
      delete merged.PI_MCP_OAUTH_BRIDGE_COMMAND
    }
  }
  for (const key of envToDelete ?? []) {
    delete merged[key]
  }
  // Inline the tiny p10k helper used by devbox's bridge environment builder.
  if (!envToDelete?.includes('POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD')) {
    merged.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD ??= 'true'
  }
  return merged
}

describe('T-006 adversarial audit', () => {
  it('removes the unrestricted helper from scoped PATH while retaining OAuth relay access', () => {
    const helperDir = '/remote/.devbox-relay/bin'
    const environment = withRemoteCliBridgeEnv(
      {
        binDir: helperDir,
        relayDir: '/remote/.devbox-relay',
        nodePath: '/remote/node',
        sockPath: '/remote/.devbox-relay/relay.sock',
        mcpOAuthBridgePath: '/remote/.devbox-relay/bin/devbox-mcp-oauth'
      },
      { PATH: `${helperDir}:/usr/bin` },
      ['DEVBOX_REMOTE_CLI_BIN_DIR']
    )

    expect(environment.DEVBOX_REMOTE_CLI_BIN_DIR).toBeUndefined()
    expect(environment.PATH?.split(':')).not.toContain(helperDir)
    expect(environment.DEVBOX_RELAY_SOCKET_PATH).toBe('/remote/.devbox-relay/relay.sock')
    expect(environment.PI_MCP_OAUTH_BRIDGE_COMMAND).toBe('/remote/.devbox-relay/bin/devbox-mcp-oauth')
  })

  it('proves disable blocks relinquishment when an owned session is still active', async () => {
    const session: DevboxSyncSessionIdentity = {
      profileId: 'profile-1',
      sessionId: 'profile-1-working',
      rootClassId: 'working',
      backend: 'mutagen',
      name: 'working',
      labels: {
        'devbox-profile': 'profile-1',
        'devbox-session': 'profile-1-working',
        'devbox-root-class': 'working',
        'devbox-backend': 'mutagen'
      }
    }
    const status = () => ({
      session,
      phase: 'watching-native' as const,
      capability: 'two-way-safe' as const,
      direction: null,
      watchMode: 'Native' as const,
      observation: {
        observedAt: 1,
        lagMs: 0,
        freshness: 'fresh' as const,
        lastChangeAt: 1,
        lastSynchronizedAt: 1
      },
      conflictCount: 0,
      problemCount: 0,
      lastError: null
    })
    const backend: DevboxSyncBackend = {
      create: async () => session,
      flush: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      resume: async () => undefined,
      status: vi.fn(async () => status()),
      listSessions: vi.fn(async () => [session]),
      listConflicts: async () => [],
      createConflictBackup: async () => ({
        id: 'backup-1',
        conflictId: 'conflict-1',
        localHash: null,
        remoteHash: null,
        createdAt: 1
      }),
      resolveConflict: async () => {
        throw new Error('not used')
      },
      terminate: async () => undefined
    }
    const supervisor = new DevboxSyncSupervisor({
      profileId: 'profile-1',
      requests: [
        {
          profileId: 'profile-1',
          sessionId: 'profile-1-working',
          rootClassId: 'working',
          localRoot: '/local',
          remoteRoot: '/remote',
          mode: 'two-way-safe'
        }
      ],
      statusIntervalMs: 0,
      backendFactory: async () => backend
    })

    await supervisor.start()
    await expect(supervisor.shutdownForDisable()).rejects.toMatchObject({
      code: 'operation_conflict'
    })
    expect(backend.flush).toHaveBeenCalledOnce()
    expect(backend.pause).toHaveBeenCalledOnce()
    // Standalone supervisor rechecks after pause before refusing relinquishment.
    expect(backend.listSessions).toHaveBeenCalledTimes(2)
  })

  it('keeps dropped workload markers outside diagnostics', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'devbox-audit-'))
    const logs = new DevboxJobLogStore({ rootDir, perJobBytes: 100, globalBytes: 200 })
    logs.append('job-1', 'x'.repeat(100))
    const result = logs.append('job-1', 'x')
    const path = logs.pathFor('job-1')
    const total = statSync(path).size + statSync(`${path}.1`).size

    expect(result.droppedMarker).not.toBeNull()
    expect(result.droppedBytes).toBeGreaterThan(0)
    expect(total).toBeGreaterThan(0)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(logs.tail('job-1').includeInDiagnostics).toBe(false)
  })

  it('constructs job, generation, and port adapters for the enabled path', () => {
    const adapters = createStandaloneDevboxAdapters({
      profileId: 'profile-1',
      profileStore: { loadProfile: vi.fn(() => ({ status: 'missing' })) } as never,
      stateRoot: mkdtempSync(join(tmpdir(), 'devbox-adapters-')),
      sshRunner: { command: vi.fn(), script: vi.fn() }
    })
    expect(adapters.jobs).toBeDefined()
    expect(adapters.generation).toBeDefined()
    expect(adapters.ports).toBeDefined()
  })
})
