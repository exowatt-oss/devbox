import type { ChildProcess } from 'node:child_process'

export function stopInteractiveChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }, 2_000)
    const finish = (): void => {
      clearTimeout(timer)
      child.off('close', finish)
      child.off('error', finish)
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
    try { child.kill('SIGTERM') } catch { finish() }
  })
}
