import { SyncMutagenError, type SyncFlushHandle, type SyncFlushResult, type SyncNowMutagen } from '../sync-now-mutagen'
import { parseSyncSessions, type SyncSessionSnapshot } from '../sync-now-session'

export type FakeFlush = { ok: true; delayMs?: number } | { error: string; delayMs?: number } | 'hang'

type EndpointState = { connected?: boolean; scanned?: boolean; files?: number }
export type SessionPatch = { status?: string; paused?: boolean; connected?: boolean; cycles?: number; alpha?: EndpointState; lastError?: string }

/**
 * In-memory stand-in for the devbox-private Mutagen daemon. Every call lands in `log`
 * (`resume:<ids>`, `pause:<ids>`, `flush:<ids>`, `kill:<ids>`) so tests can assert order.
 */
export class FakeMutagen implements SyncNowMutagen {
  readonly sessions = new Map<string, Record<string, unknown>>()
  readonly log: string[] = []
  flushBehaviour: (ids: readonly string[]) => FakeFlush = () => ({ ok: true })
  /** Per-session flush time for an ok flush (default: the behaviour's delayMs). */
  flushDelayFor: (id: string) => number | undefined = () => undefined
  /** State a session takes when resumed (default: connected and watching). */
  resumedState: (id: string) => SessionPatch = () => ({ status: 'watching', connected: true })
  resumeError: (ids: readonly string[]) => Error | undefined = () => undefined
  /** A pause CLI failure; `lands` = the daemon still pauses the sessions (a timed-out call). */
  pauseError: (ids: readonly string[]) => { error: Error; lands: boolean } | undefined = () => undefined
  onList: (fake: FakeMutagen) => void = () => undefined
  listFailures = 0
  listCalls = 0

  constructor(sessions: readonly Record<string, unknown>[]) {
    for (const session of sessions) {this.sessions.set(String(session.identifier), structuredClone(session))}
  }

  async list(): Promise<SyncSessionSnapshot[]> {
    this.listCalls += 1
    if (this.listFailures > 0) {
      this.listFailures -= 1
      throw new SyncMutagenError('unable to connect to daemon: connection refused', false)
    }
    this.onList(this)
    return parseSyncSessions(JSON.stringify([...this.sessions.values()]))
  }

  async resume(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {return}
    this.log.push(`resume:${ids.join(',')}`)
    for (const id of ids) {this.set(id, { paused: false, ...this.resumedState(id) })}
    const error = this.resumeError(ids)
    if (error) {throw error}
  }

  async pause(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {return}
    this.log.push(`pause:${ids.join(',')}`)
    const failure = this.pauseError(ids)
    if (failure === undefined || failure.lands) {for (const id of ids) {this.set(id, { paused: true, status: 'disconnected', connected: false })}}
    if (failure !== undefined) {throw failure.error}
  }

  flush(ids: readonly string[], onFlushed?: (id: string) => void): SyncFlushHandle {
    this.log.push(`flush:${ids.join(',')}`)
    const behaviour = this.flushBehaviour(ids)
    let resolve: (result: SyncFlushResult) => void = () => undefined
    const done = new Promise<SyncFlushResult>((settle) => { resolve = settle })
    if (behaviour !== 'hang' && 'error' in behaviour) {
      setTimeout(() => resolve({ ok: false, message: behaviour.error }), behaviour.delayMs ?? 5)
    } else if (behaviour !== 'hang') {
      // Each session finishes its own flush (as the per-session Mutagen calls do).
      let pending = ids.length
      for (const id of ids) {
        setTimeout(() => {
          this.set(id, { status: 'watching', connected: true, cycles: this.cycles(id) + 1, alpha: { scanned: true, files: 10 } })
          onFlushed?.(id)
          pending -= 1
          if (pending === 0) {resolve({ ok: true })}
        }, this.flushDelayFor(id) ?? behaviour.delayMs ?? 5)
      }
    }
    return { done, kill: () => { this.log.push(`kill:${ids.join(',')}`); resolve({ ok: false, message: 'signal: terminated' }) } }
  }

  set(id: string, patch: SessionPatch): void {
    const session = this.sessions.get(id)
    if (!session) {return}
    const alpha = { ...session.alpha as Record<string, unknown> }
    const beta = { ...session.beta as Record<string, unknown> }
    if (patch.connected !== undefined) {
      alpha.connected = patch.connected
      beta.connected = patch.connected
    }
    Object.assign(alpha, patch.alpha ?? {})
    this.sessions.set(id, {
      ...session,
      alpha,
      beta,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.paused === undefined ? {} : { paused: patch.paused }),
      ...(patch.cycles === undefined ? {} : { successfulCycles: patch.cycles }),
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError })
    })
  }

  pauseDetached(ids: readonly string[]): void {
    this.log.push(`detached-pause:${ids.join(',')}`)
  }

  paused(id: string): boolean {
    return this.sessions.get(id)?.paused === true
  }

  private cycles(id: string): number {
    const value = this.sessions.get(id)?.successfulCycles
    return typeof value === 'number' ? value : 0
  }
}
