import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSyncLock, processStartedAt, syncLockPath, tryAcquireSyncLock, type SyncLockHolder } from './sync-now-lock'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })} })

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'devbox-sync-lock-'))
  roots.push(root)
  return syncLockPath(join(root, 'state'))
}

describe('db sync run lock', () => {
  it('takes the lock with pid + startedAt + command and releases only its own record', async () => {
    const path = lockPath()
    const handle = await acquireSyncLock({ path, pid: 111, now: () => 5 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pid: 111, startedAt: 5, command: 'db sync' })
    writeFileSync(path, JSON.stringify({ pid: 222, startedAt: 6 }))
    handle!.release()
    expect(existsSync(path)).toBe(true)
    writeFileSync(path, `${JSON.stringify({ pid: 111, startedAt: 5, command: 'db sync' })}\n`)
    handle!.release()
    expect(existsSync(path)).toBe(false)
  })

  it('reports a live holder and waits until it lets go', async () => {
    const path = lockPath()
    const holder = tryAcquireSyncLock({ path, pid: 222, now: () => 1, command: 'db mutagen restart' })
    expect('handle' in holder).toBe(true)
    const waits: SyncLockHolder[] = []
    let sleeps = 0
    const handle = await acquireSyncLock({
      path,
      pid: 333,
      isAlive: (pid) => pid === 222,
      startedAtOf: () => 1,
      onWait: (seen) => waits.push(seen),
      sleep: async () => {
        sleeps += 1
        if (sleeps === 3 && 'handle' in holder) {holder.handle.release()}
      }
    })
    // The waiter learns what it waits for, so it never calls a daemon restart `another db sync`.
    expect(waits).toEqual([{ pid: 222, startedAt: 1, command: 'db mutagen restart' }])
    expect(sleeps).toBe(3)
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(333)
    handle!.release()
  })

  it('replaces a stale lock whose pid is gone, and an unreadable one', () => {
    const path = lockPath()
    tryAcquireSyncLock({ path, pid: 999_999, now: () => 1 })
    const taken = tryAcquireSyncLock({ path, pid: 444, isAlive: () => false })
    expect('handle' in taken).toBe(true)
    writeFileSync(path, 'garbage')
    expect('handle' in tryAcquireSyncLock({ path, pid: 555, isAlive: () => true })).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(555)
  })

  it('gives up waiting when the signal aborts', async () => {
    const path = lockPath()
    tryAcquireSyncLock({ path, pid: 222 })
    const controller = new AbortController()
    const onWait = vi.fn(() => controller.abort())
    const handle = await acquireSyncLock({ path, pid: 333, isAlive: () => true, onWait, signal: controller.signal, pollMs: 10_000 })
    expect(handle).toBeUndefined()
    expect(onWait).toHaveBeenCalledOnce()
  })

  it('treats a live pid that started after the lock was written as a reused pid (stale lock)', () => {
    const path = lockPath()
    tryAcquireSyncLock({ path, pid: 222, now: () => 1_000_000 })
    const reused = tryAcquireSyncLock({ path, pid: 333, isAlive: () => true, startedAtOf: () => 2_000_000 })
    expect('handle' in reused).toBe(true)
    if ('handle' in reused) {reused.handle.release()}
    tryAcquireSyncLock({ path, pid: 222, now: () => 1_000_000 })
    const holder = tryAcquireSyncLock({ path, pid: 333, isAlive: () => true, startedAtOf: () => 999_000 })
    expect(holder).toEqual({ holder: { pid: 222, startedAt: 1_000_000, command: 'db sync' } })
  })

  it('reads a process start time from ps', () => {
    const started = processStartedAt(process.pid)
    expect(started).toBeDefined()
    expect(started!).toBeLessThanOrEqual(Date.now())
    expect(Date.now() - started!).toBeLessThan(process.uptime() * 1_000 + 2_000)
    expect(processStartedAt(2 ** 30)).toBeUndefined()
  })

  it('treats the real current process as alive by default', () => {
    const path = lockPath()
    tryAcquireSyncLock({ path, pid: process.pid })
    const attempt = tryAcquireSyncLock({ path, pid: 1234 })
    expect(attempt).toEqual({ holder: { pid: process.pid, startedAt: expect.any(Number), command: 'db sync' } })
  })
})
