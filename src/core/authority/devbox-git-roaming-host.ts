import { lstat, mkdir, readdir, readFile, rename, open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { DevboxSshRunner } from '../../shared/ssh-runner-types'
import type { DevboxGitRoamingHost, DevboxGitRoamingFileSystem, DevboxGitRoamingCommandResult } from './devbox-git-roaming-types'

const execFileAsync = promisify(execFile)
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

function localFiles(): DevboxGitRoamingFileSystem {
  return {
    async exists(path) { try { await lstat(path); return true } catch { return false } },
    async isDirectory(path) { try { return (await lstat(path)).isDirectory() } catch { return false } },
    async readFile(path) { try { return await readFile(path, 'utf8') } catch { return undefined } },
    async list(path) {
      try {
        return (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      } catch { return [] }
    },
    async rename(from, to) { await rename(from, to) },
    async writeFile(path, value) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const handle = await open(path, 'w', 0o600)
      try { await handle.writeFile(value, { encoding: 'utf8' }); await handle.sync() } finally { await handle.close() }
    },
    async syncDirectory(path) {
      try { const handle = await open(path, 'r'); await handle.sync(); await handle.close() } catch { /* best effort on remote/filesystem variants */ }
    }
  }
}

export function createLocalGitRoamingHost(root: string): DevboxGitRoamingHost {
  return {
    root,
    files: localFiles(),
    async run(cwd, args, environment): Promise<DevboxGitRoamingCommandResult> {
      try {
        const result = await execFileAsync('git', [...args], { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...environment } })
        return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 }
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? 'git failed', exitCode: typeof failure.code === 'number' ? failure.code : 1 }
      }
    }
  }
}

function remoteFiles(ssh: DevboxSshRunner): DevboxGitRoamingFileSystem {
  const command = async (script: string): Promise<string | undefined> => {
    try { return await ssh.command(script, 30_000) } catch { return undefined }
  }
  return {
    async exists(path) { return (await command(`test -e ${quote(path)}`)) !== undefined },
    async isDirectory(path) { return (await command(`test -d ${quote(path)}`)) !== undefined },
    async readFile(path) { return command(`cat ${quote(path)}`) },
    async list(path) {
      const output = await command(`for child in ${quote(path)}/* ${quote(path)}/.[!.]* ${quote(path)}/..?*; do [ -e "$child" ] || [ -L "$child" ] || continue; if [ -d "$child" ]; then kind=d; else kind=f; fi; printf '%s\\t%s\\n' "$kind" "$(basename "$child")"; done`)
      return (output ?? '').split('\n').flatMap((line) => {
        const [kind, name] = line.split('\t')
        return name ? [{ name, directory: kind === 'd' }] : []
      })
    },
    async rename(from, to) {
      await ssh.command(`mv ${quote(from)} ${quote(to)}`, 30_000)
    },
    async writeFile(path, value) {
      const encoded = Buffer.from(value, 'utf8').toString('base64')
      await ssh.command(`mkdir -p ${quote(dirname(path))} && printf %s ${quote(encoded)} | if [ "$(uname -s)" = Darwin ]; then base64 -D; else base64 -d; fi > ${quote(path)} && chmod 600 ${quote(path)}`, 30_000)
    },
    async syncDirectory() { /* remote rename is durable enough for the SSH adapter */ }
  }
}

export function createSshGitRoamingHost(root: string, ssh: DevboxSshRunner): DevboxGitRoamingHost {
  return {
    root,
    files: remoteFiles(ssh),
    async run(cwd, args, environment) {
      const prefix = environment && Object.keys(environment).length ? `env ${Object.entries(environment).map(([key, value]) => `${quote(key)}=${quote(value)}`).join(' ')} ` : ''
      const command = `${prefix}${['git', '-C', cwd, ...args].map(quote).join(' ')}`
      try { return { stdout: await ssh.command(command, 30_000), stderr: '', exitCode: 0 } }
      catch (error) { return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 } }
    }
  }
}
