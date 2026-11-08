import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSyncHooks, syncHooksDirectory } from './sync-now-hooks'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })} })

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devbox-sync-hooks-'))
  roots.push(root)
  mkdirSync(syncHooksDirectory(root), { recursive: true })
  return root
}

function hook(root: string, profileId: string, body: string, mode = 0o755): string {
  const path = join(syncHooksDirectory(root), profileId)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, mode)
  return path
}

const context = { profileId: 'phi-sessions', host: 'devbox', user: 'alice' }

describe('db sync hooks', () => {
  it('finds only executable hook files named after the profile', () => {
    const root = stateRoot()
    const hooks = createSyncHooks({ stateRoot: root, env: process.env })
    const path = hook(root, 'phi-sessions', 'exit 0')
    hook(root, 'roam', 'exit 0', 0o644)
    mkdirSync(join(syncHooksDirectory(root), 'adir'))
    expect(hooks.find('phi-sessions')).toBe(path)
    expect(hooks.find('roam')).toBeUndefined()
    expect(hooks.find('adir')).toBeUndefined()
    expect(hooks.find('missing')).toBeUndefined()
    expect(hooks.find('../escape')).toBeUndefined()
  })

  it('runs `<hook> before|after` with the DEVBOX_SYNC_* environment', async () => {
    const root = stateRoot()
    const out = join(root, 'out.txt')
    const path = hook(root, 'phi-sessions', `echo "$1 $DEVBOX_SYNC_PHASE $DEVBOX_SYNC_PROFILE $DEVBOX_SYNC_USER@$DEVBOX_SYNC_HOST" >> "${out}"`)
    const hooks = createSyncHooks({ stateRoot: root, env: process.env })
    expect(await hooks.run(path, 'before', context, new AbortController().signal)).toBeUndefined()
    expect(await hooks.run(path, 'after', context, new AbortController().signal)).toBeUndefined()
    expect(readFileSync(out, 'utf8')).toBe('before before phi-sessions alice@devbox\nafter after phi-sessions alice@devbox\n')
  })

  it('turns a failing hook into a one-line warning with its last stderr line', async () => {
    const root = stateRoot()
    const path = hook(root, 'phi-sessions', 'echo first >&2; echo "stage failed" >&2; exit 3')
    const warning = await createSyncHooks({ stateRoot: root, env: process.env }).run(path, 'before', context, new AbortController().signal)
    expect(warning).toBe('hook phi-sessions before failed (exit 3): stage failed')
  })

  it('times out a hung hook and stops it on interrupt', async () => {
    const root = stateRoot()
    const path = hook(root, 'phi-sessions', 'exec sleep 30')
    const slow = createSyncHooks({ stateRoot: root, env: process.env, timeoutMs: 100 })
    expect(await slow.run(path, 'after', context, new AbortController().signal)).toBe('hook phi-sessions after timed out after 100 ms')
    const controller = new AbortController()
    const pending = createSyncHooks({ stateRoot: root, env: process.env }).run(path, 'before', context, controller.signal)
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toBe('hook phi-sessions before interrupted')
  })

  it('stops a hung grandchild (the hook\'s ssh) at the cap instead of waiting on its pipes', async () => {
    const root = stateRoot()
    const pidFile = join(root, 'grandchild.pid')
    // Not `exec`: sh forks the sleep, which inherits stdout/stderr like a hook's ssh does.
    const path = hook(root, 'phi-sessions', `sleep 30 & echo $! > "${pidFile}"; wait`)
    const started = Date.now()
    // 1 s leaves a loaded machine time to fork the sleep and write its pid before the cap.
    const warning = await createSyncHooks({ stateRoot: root, env: process.env, timeoutMs: 1_000 }).run(path, 'before', context, new AbortController().signal)
    expect(warning).toBe('hook phi-sessions before timed out after 1 s')
    expect(Date.now() - started).toBeLessThan(6_000)
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false))
  })

  it('finishes a hook that exited even when a background grandchild keeps the pipes open', async () => {
    const root = stateRoot()
    const pidFile = join(root, 'background.pid')
    const path = hook(root, 'phi-sessions', `(sleep 30 & echo $! > "${pidFile}")\nexit 0`)
    const started = Date.now()
    expect(await createSyncHooks({ stateRoot: root, env: process.env }).run(path, 'after', context, new AbortController().signal)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
