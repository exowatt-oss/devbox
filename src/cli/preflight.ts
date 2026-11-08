import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSystemSshRunner } from '../ssh/system-ssh-runner'
import { createDevboxError } from '../shared/devbox-errors'
import { commandExecFileAsync } from '../shared/exec'
import {
  DevboxPreflight,
  type DevboxExecRequest,
  type DevboxExecResult,
  type DevboxPreflightResult
} from '../core/devbox-preflight'
import { DevboxProfileStore } from '../core/devbox-profile-store'
import { createLocalGitRoamingHost, createSshGitRoamingHost } from '../core/authority/devbox-git-roaming-host'
import { runGitRoamingPreflight } from '../core/devbox-git-roaming-preflight'
import { profileSshEndpoint } from './profile-ssh'
import { checkSshProxyRoute, withSshProxyRoute } from './preflight-ssh-route'

export async function runPreflight(
  profileId: string,
  options: { profileRoot: string; env: NodeJS.ProcessEnv }
): Promise<DevboxPreflightResult> {
  const store = new DevboxProfileStore({ rootDir: options.profileRoot, env: options.env })
  const loaded = store.loadProfile(profileId)
  if (loaded.status !== 'loaded') {
    throw 'error' in loaded ? loaded.error : createDevboxError('profile_not_found')
  }
  const identity = loaded.profile.sshTarget.identity
  const knownHostsFile = join(options.profileRoot, profileId, 'known_hosts')
  const ssh = createSystemSshRunner(profileSshEndpoint(loaded.profile, existsSync(knownHostsFile) ? knownHostsFile : undefined))
  const remoteExec = async (request: {
    command: string
    args: readonly string[]
    signal?: AbortSignal
  }) => {
    try {
      const stdout = await ssh.command(
        [request.command, ...request.args].map(shellQuote).join(' '),
        120_000
      )
      return { exitCode: 0, stdout, stderr: '', identity }
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        identity
      }
    }
  }
  const base = withSshProxyRoute(await new DevboxPreflight(loaded.profile, {
    remoteExec,
    localExec,
    clock: Date.now
  }).run(), await checkSshProxyRoute(loaded.profile))
  if (!loaded.profile.gitRoaming?.enabled || base.status === 'cancelled') {return base}
  const roaming = await runGitRoamingPreflight(
    loaded.profile,
    createLocalGitRoamingHost(loaded.profile.roots.localRoot),
    createSshGitRoamingHost(loaded.profile.roots.remoteRoot, ssh)
  )
  const check = {
    id: 'git-roaming' as const,
    status: roaming.status === 'ready' ? 'pass' as const : 'fail' as const,
    remediation: roaming.status === 'ready' ? 'The two clone sets can pair; dirty, unpublished, and linked-worktree findings remain handoff-time constraints.' : roaming.blockers[0]?.message ?? 'Resolve the pair-time Git roaming blockers before pairing.',
    blocking: roaming.blockers.length > 0,
    details: {
      repositories: roaming.local.repositories.length,
      localManifest: roaming.local.manifestDigest,
      remoteManifest: roaming.remote.manifestDigest,
      dirtyRepositories: roaming.local.dirtyRepositories + roaming.remote.dirtyRepositories,
      unpublishedRepositories: roaming.local.unpublishedRepositories + roaming.remote.unpublishedRepositories,
      blockers: roaming.blockers.map((item) => item.repository ? `${item.repository}: ${item.code}` : item.code),
      informational: roaming.informational.map((item) => item.repository ? `${item.repository}: ${item.code}` : item.code),
      warnings: roaming.warnings.map((item) => item.repository ? `${item.repository}: ${item.message}` : item.message)
    }
  }
  return {
    ...base,
    status: roaming.status === 'ready' && base.status === 'ready' ? 'ready' as const : 'blocked' as const,
    checks: [...base.checks, check],
    blockers: roaming.status === 'ready' ? base.blockers : [...base.blockers, check],
    ...(roaming.status === 'ready' ? {} : { blockedReason: 'git-roaming-blocked' as const })
  }
}

export async function localExec(request: DevboxExecRequest): Promise<DevboxExecResult> {
  try {
    const result = await commandExecFileAsync(request.command, request.args, {
      signal: request.signal,
      // Why: the path inventory prints one JSON line per non-excluded entry of
      // the local root; a multi-repo superrepo overflowed 128 MiB and reported
      // 'path-inventory-failed'. 1.5 GiB stays under Node's string ceiling.
      maxBuffer: 1536 * 1024 * 1024
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
