import { execFile } from 'node:child_process'

/**
 * Minimal external-command execution used across Devbox (Mutagen, git, and
 * SSH helpers). Arguments are always argv arrays — never shell-interpolated.
 */
export type CommandExecOptions = {
  cwd?: string
  encoding?: BufferEncoding
  maxBuffer?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export type CommandExecResult = {
  stdout: string
  stderr: string
}

export async function commandExecFileAsync(
  command: string,
  args: readonly string[],
  options: CommandExecOptions = {}
): Promise<CommandExecResult> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: options.encoding ?? 'utf-8',
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        timeout: options.timeout,
        env: options.env,
        signal: options.signal
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & {
            stdout?: string
            stderr?: string
          }
          failure.stdout = String(stdout)
          failure.stderr = String(stderr)
          reject(failure)
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}
