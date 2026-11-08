/**
 * The SSH execution capability consumed by Devbox core (job transport,
 * provisioner, preflight, ports). Standalone Devbox backs it with the system
 * OpenSSH client (`src/ssh/system-ssh-runner.ts`).
 *
 * Contract:
 * - `command` runs a single remote command and resolves with stdout.
 * - `script` streams the script to a remote `bash -s` stdin and resolves
 *   with stdout.
 * - Both reject with an Error on non-zero exit or timeout; stderr is
 *   included in the error message.
 */
export type DevboxSshRunner = {
  command(command: string, timeoutMs?: number): Promise<string>
  script(script: string, timeoutMs?: number): Promise<string>
}

/** Minimal SSH endpoint identity used to spawn system-ssh processes. */
export type SshEndpoint = {
  host: string
  port: number
  username: string
  /**
   * Absolute path to a known_hosts file pinning exactly this endpoint's
   * host key, or undefined to defer to the user's default known_hosts.
   */
  knownHostsFile?: string
  /** Extra `-o` options appended after the hardening defaults. */
  extraOptions?: readonly string[]
}
