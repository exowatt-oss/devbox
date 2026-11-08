import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { createDevboxError } from '../../shared/devbox-errors'
import { inventoryGitRoamingRoot } from './devbox-git-roaming-inventory'
import { makeDevboxGitRoamingMarker } from './devbox-git-roaming-remote'
import { createFileTopologyRecords, setRootTopology } from './devbox-git-roaming-parking'
import type { DevboxGitRoamingBlocker, DevboxGitRoamingInventory, DevboxGitRoamingHandoffResult, DevboxGitRoamingOptions, DevboxGitRoamingRepository, DevboxGitRoamingStatus, DevboxGitRoamingSide, DevboxGitRoamingTransition, DevboxGitRoamingGitResult, DevboxGitRoamingWarning } from './devbox-git-roaming-types'
export type * from './devbox-git-roaming-types'

const readCommands = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'cat-file', 'ls-remote'])
const stateName = 'state.json'
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const now = (value?: () => number): (() => number) => value ?? Date.now
const pairBlockingCodes = new Set<DevboxGitRoamingBlocker['code']>([
  'root-mismatch',
  'missing-repository',
  'malformed-repository',
  'park-failed',
  'unpark-failed',
  'transition-blocked',
  'sync-conflict',
  'external-drift'
])

export class DevboxGitRoamingController {
  private readonly options: DevboxGitRoamingOptions
  private readonly clock: () => number
  private readonly statePath: string
  private readonly records: ReturnType<typeof createFileTopologyRecords>
  private state: { owner: DevboxGitRoamingSide; epochSequence: number; epoch: string; transition: DevboxGitRoamingTransition; transitionId: string; manifestDigest: string; refreshAt?: number; warnings: readonly DevboxGitRoamingWarning[] }

  constructor(options: DevboxGitRoamingOptions) {
    this.options = options
    this.clock = now(options.now)
    this.statePath = join(options.stateRoot, 'profiles', options.profileId, 'git-roaming', stateName)
    this.records = createFileTopologyRecords(options.local.files, join(options.stateRoot, 'profiles', options.profileId, 'git-roaming', 'topology'))
    this.state = { owner: options.defaultOwner ?? 'local', epochSequence: 0, epoch: `initial:${options.profileId}`, transition: 'idle', transitionId: `initial:${options.profileId}`, manifestDigest: '', warnings: [] }
  }

  async initialize(): Promise<void> {
    const raw = await this.options.local.files.readFile(this.statePath)
    if (raw) {
      await this.loadState()
      if (this.state.transition !== 'idle') { await this.recover() }
      return
    }
    const owner = this.state.owner
    const passive = owner === 'local' ? 'remote' : 'local'
    this.state = { ...this.state, transition: 'candidate', transitionId: `pair-init:${this.options.profileId}:${randomUUID()}` }
    await this.persist()
    try {
      const inventory = await this.inventory(passive)
      const blockers = await setRootTopology(this.options[passive], inventory.repositories, passive, false, this.state.transitionId, this.clock, this.records)
      if (blockers.length) {throw createDevboxError('operation_conflict', { message: blockers[0]!.message, context: { field: 'git-roaming-initialize' } })}
      if (this.options.failureStage === 'candidate') {throw new Error('injected pair initialization interruption')}
      const warnings = this.options.refresh ? [...(await this.options.refresh(passive, inventory.repositories) ?? [])] : []
      this.state = { ...this.state, transition: 'reconciling', manifestDigest: inventory.manifestDigest, warnings, ...(this.options.refresh ? { refreshAt: this.clock() } : {}) }
      await this.persist()
      await this.writeMarker(inventory.manifestDigest)
      this.state = { ...this.state, transition: 'idle' }
      await this.persist()
    } catch (error) {
      await this.recover()
      throw error
    }
  }

  async status(): Promise<DevboxGitRoamingStatus> {
    await this.loadState()
    if (this.state.transition !== 'idle') {await this.recover(this.options.supervisor)}
    const [local, remote] = await Promise.all([this.inventory('local'), this.inventory('remote')])
    const witnesses = await this.witnessState()
    const inventoryWarnings = [...local.blockers, ...remote.blockers].filter((item) => !pairBlockingCodes.has(item.code)).map((item) => ({ code: 'handoff-required' as const, repository: item.repository, message: `Informational at pair time: ${item.message}` }))
    const warnings = [...this.state.warnings, ...inventoryWarnings].slice(0, 128)
    const refreshFailed = this.state.warnings.some((item) => item.code === 'fetch-failed' || item.code === 'passive-object-missing')
    return { enabled: this.options.config.enabled, topology: 'working-tree-only', authorityScope: 'profile', owner: this.state.owner, epochSequence: this.state.epochSequence, epoch: this.state.epoch, transition: this.state.transition, witnesses, repositories: Math.max(local.repositories.length, remote.repositories.length), manifest: local.manifestDigest === remote.manifestDigest ? 'verified' : 'blocked', localGit: sideTopology(local), remoteGit: sideTopology(remote), dirtyRepositories: local.dirtyRepositories + remote.dirtyRepositories, unpublishedRepositories: local.unpublishedRepositories + remote.unpublishedRepositories, passiveRefresh: refreshFailed ? 'required' : this.state.refreshAt && this.clock() - this.state.refreshAt < 60_000 ? 'fresh' : this.state.refreshAt ? 'stale' : 'unknown', ...(this.state.refreshAt ? { passiveRefreshAt: this.state.refreshAt } : {}), syncBarrier: this.state.transition === 'quiesced' || this.state.transition === 'reconciling' ? 'paused' : 'running', fence: 'cooperative', blockers: [...local.blockers, ...remote.blockers].filter((item) => pairBlockingCodes.has(item.code)).slice(0, 32), warnings }
  }

  async inventory(side: DevboxGitRoamingSide): Promise<DevboxGitRoamingInventory> { return inventoryGitRoamingRoot(this.options[side], side, this.clock) }

  async handoff(targetOwner: DevboxGitRoamingSide, supervisor = this.options.supervisor): Promise<DevboxGitRoamingHandoffResult> {
    const started = this.clock(); await this.loadState()
    if (this.state.transition !== 'idle') {await this.recover(supervisor)}
    const witnesses = await this.witnessState()
    if (this.options.marker && witnesses !== 'agree') {return this.result('blocked', targetOwner, started, [{ code: witnesses === 'split' ? 'split-authority' : 'witness-corrupt', message: 'The checksummed authority witnesses are missing or disagree; handoff is refused.' }])}
    if (this.state.owner === targetOwner && this.state.transition === 'idle') {return this.result('replayed', targetOwner, started, [], this.state.warnings)}
    const oldOwner = this.state.owner
    const target = this.options[targetOwner]
    const source = await this.inventory(oldOwner)
    const targetBefore = await this.inventory(targetOwner)
    const blockers = source.blockers.filter((item) => item.code !== 'missing-passive-object')
    if (source.repositories.length === 0 || source.repositories.length !== targetBefore.repositories.length) {blockers.push({ code: 'missing-repository', message: 'Both clone sets must contain the same repository manifest.' })}
    if (blockers.length) {return this.result('blocked', targetOwner, started, blockers, this.state.warnings)}
    const transitionId = `handoff:${this.options.profileId}:${randomUUID()}`
    this.state = { ...this.state, transition: 'candidate', transitionId, manifestDigest: source.manifestDigest }
    await this.persist()
    try {
      await supervisor?.flush()
      await supervisor?.pause(); this.state = { ...this.state, transition: 'quiesced' }; await this.persist()
      const verified = await supervisor?.verify(); if (verified && (!verified.fresh || verified.conflictCount > 0)) {throw new Error('sync conflict or stale working-tree barrier')}
      await this.hold('quiesced')
      if (this.options.failureStage === 'quiesced') {throw new Error('injected handoff interruption')}
      const refreshWarnings = [...(await (this.options.refresh ?? (async () => []))(targetOwner, targetBefore.repositories) ?? [])]
      this.state = { ...this.state, warnings: refreshWarnings, refreshAt: this.clock() }
      await this.persist()
      if (refreshWarnings.length) {throw new Error(refreshWarnings[0]!.message)}
      await this.adoptTarget(target, targetBefore.repositories, source.repositories)
      this.state = { ...this.state, transition: 'reconciling' }; await this.persist()
      await this.hold('reconciling')
      if (this.options.failureStage === 'reconciling') {throw new Error('injected handoff interruption')}
      const oldRepos = source.repositories, newRepos = targetBefore.repositories
      const oldBlockers = await setRootTopology(this.options[oldOwner], oldRepos, oldOwner, false, transitionId, this.clock, this.records)
      if (oldBlockers.length) {throw new Error(oldBlockers[0]!.message)}
      const newBlockers = await setRootTopology(target, newRepos, targetOwner, true, transitionId, this.clock, this.records)
      if (newBlockers.length) {throw new Error(newBlockers[0]!.message)}
      const after = await this.inventory(targetOwner)
      const topologyBlockers = after.repositories.filter((item) => item.topology === 'mixed' || item.topology === 'missing')
      if (after.repositories.length !== source.repositories.length || topologyBlockers.length) {throw new Error('target topology verification failed')}
      this.state = { ...this.state, owner: targetOwner, epochSequence: this.state.epochSequence + 1, epoch: `authority:${this.options.profileId}:${this.state.epochSequence + 1}:${targetOwner}:${randomUUID()}`, transition: 'committed', manifestDigest: after.manifestDigest, refreshAt: this.clock() }
      await this.persist(); await this.writeMarker(after.manifestDigest)
      if (this.options.failureStage === 'committed') {throw new Error('injected handoff interruption')}
      await supervisor?.resume(); this.state = { ...this.state, transition: 'idle' }; await this.persist()
      return this.result('committed', targetOwner, started, [])
    } catch (error) {
      if (this.state.transition === 'committed') { return this.result('blocked', targetOwner, started, [{ code: 'transition-blocked', message: `Handoff committed but sync remains paused: ${error instanceof Error ? error.message : String(error)}` }], this.state.warnings) }
      await this.recover(supervisor)
      return this.result('blocked', targetOwner, started, [{ code: 'transition-blocked', message: error instanceof Error ? error.message : String(error) }], this.state.warnings)
    }
  }

  async runGit(side: DevboxGitRoamingSide, repositoryPath: string, argv: readonly string[]): Promise<DevboxGitRoamingGitResult> {
    await this.loadState()
    const first = argv[0]
    if (!first || argv.some((arg) => arg === '--git-dir' || arg.startsWith('--git-dir=') || arg === '--work-tree' || arg.startsWith('--work-tree=') || arg === '-C' || arg === '-c' || arg.startsWith('--config') || arg === '--exec-path' || arg.includes(';') || arg.includes('|'))) {throw createDevboxError('operation_conflict', { message: 'Unsafe or ambiguous git argv was rejected by the roaming proxy.', context: { field: 'git-argv' } })}
    const passive = this.state.owner !== side
    const readOnly = readCommands.has(first) || (first === 'branch' && argv[1] === '--list') || (first === 'tag' && argv[1] === '--list')
    if (passive && !readOnly) {throw createDevboxError('operation_conflict', { message: `Git mutation refused: profile authority is ${this.state.owner}. Run devbox handoff --to ${side} first.`, context: { field: 'git-authority' } })}
    const root = this.options[side]; const relativePath = repositoryPath.startsWith(`${root.root}/`) ? repositoryPath.slice(root.root.length + 1) : repositoryPath
    const repo = (await this.inventory(side)).repositories.find((item) => item.relativePath === relativePath || item.path === repositoryPath)
    if (!repo) {throw createDevboxError('operation_conflict', { message: 'The requested path is not an included roaming repository.', context: { field: 'git-path' } })}
    const gitPath = repo.commandGitPath
    const result = await root.run(repo.path, [`--git-dir=${gitPath}`, `--work-tree=${repo.path}`, ...argv], passive ? { GIT_OPTIONAL_LOCKS: '0' } : undefined)
    const stdout = passive && first === 'status' ? result.stdout.split('\n').filter((line) => !line.includes('.git.devbox-parked')).join('\n') : result.stdout
    return { ...result, stdout, side, passive }
  }

  private async adoptTarget(host: DevboxGitRoamingOptions['local'], repos: readonly DevboxGitRoamingRepository[], source: readonly DevboxGitRoamingRepository[]): Promise<void> {
    for (const current of source) {
      const target = repos.find((item) => item.relativePath === current.relativePath)
      if (!target || !current.branch || !current.head) {throw new Error(`missing target repository: ${current.relativePath}`)}
      const gitPath = target.commandGitPath
      for (const args of [['update-ref', `refs/heads/${current.branch}`, current.head], ['symbolic-ref', 'HEAD', `refs/heads/${current.branch}`], ['read-tree', '--reset', 'HEAD']] as const) {
        const result = await host.run(target.path, [`--git-dir=${gitPath}`, `--work-tree=${target.path}`, ...args]); if (result.exitCode !== 0) {throw new Error(`target metadata adoption failed: ${current.relativePath}`)}
      }
      const check = await host.run(target.path, [`--git-dir=${gitPath}`, `--work-tree=${target.path}`, 'status', '--porcelain', '--untracked-files=all'])
      if (check.exitCode !== 0 || check.stdout.split('\n').some((line) => line && !line.includes('.git.devbox-parked'))) {throw new Error(`target working tree differs from published HEAD: ${current.relativePath}`)}
    }
  }

  private async recover(supervisor?: DevboxGitRoamingOptions['supervisor']): Promise<void> {
    if (this.state.transition === 'idle') {return}
    const desiredOld = this.state.owner
    const desiredNew: DevboxGitRoamingSide = desiredOld === 'local' ? 'remote' : 'local'
    const oldInventory = await this.inventory(desiredOld), newInventory = await this.inventory(desiredNew)
    const oldRepos = oldInventory.repositories, newRepos = newInventory.repositories
    if (this.state.transition === 'committed') { await setRootTopology(this.options[desiredOld], oldRepos, desiredOld, true, this.state.transitionId, this.clock, this.records); await setRootTopology(this.options[desiredNew], newRepos, desiredNew, false, this.state.transitionId, this.clock, this.records); await supervisor?.resume(); this.state = { ...this.state, transition: 'idle' }; await this.persist(); return }
    const pairInitialization = this.state.transitionId.startsWith('pair-init:')
    await setRootTopology(this.options[desiredOld], oldRepos, desiredOld, true, this.state.transitionId, this.clock, this.records)
    await setRootTopology(this.options[desiredNew], newRepos, desiredNew, pairInitialization, this.state.transitionId, this.clock, this.records)
    await supervisor?.resume(); this.state = { ...this.state, transition: 'idle' }; await this.persist()
  }

  private async hold(stage: DevboxGitRoamingTransition): Promise<void> {
    if (this.options.holdStage !== stage || !this.options.holdMs || this.options.holdMs <= 0) {return}
    await new Promise((resolve) => setTimeout(resolve, this.options.holdMs))
  }

  private async witnessState(): Promise<'agree' | 'missing' | 'corrupt' | 'split'> { if (!this.options.marker) {return 'agree';} const marker = await this.options.marker.read(); if (!marker) {return 'missing';} return marker.epoch === this.state.epoch && marker.epochSequence === this.state.epochSequence ? 'agree' : 'split' }
  private async writeMarker(manifestDigest: string): Promise<void> { if (!this.options.marker) {return;} await this.options.marker.write(makeDevboxGitRoamingMarker({ schemaVersion: 1, profileId: this.options.profileId, epochSequence: this.state.epochSequence, epoch: this.state.epoch, owner: this.state.owner, transitionId: this.state.transitionId, stage: this.state.transition === 'idle' ? 'committed' : this.state.transition, manifestDigest, updatedAt: this.clock() })) }
  private async loadState(): Promise<void> { const raw = await this.options.local.files.readFile(this.statePath); if (!raw) {return;} try { const parsed = JSON.parse(raw) as Partial<typeof this.state>; if (parsed.owner === 'local' || parsed.owner === 'remote') {this.state = { ...this.state, ...parsed, warnings: parsed.warnings ?? [] } } } catch { this.state = { ...this.state, transition: 'blocked' } } }
  private async persist(): Promise<void> { await this.options.local.files.writeFile(this.statePath, JSON.stringify({ ...this.state, checksum: digest(JSON.stringify(this.state)) })); }
  private result(status: DevboxGitRoamingHandoffResult['status'], targetOwner: DevboxGitRoamingSide, started: number, blockers: readonly DevboxGitRoamingBlocker[], warnings: readonly DevboxGitRoamingWarning[] = this.state.warnings): DevboxGitRoamingHandoffResult { return { status, profileId: this.options.profileId, owner: this.state.owner, targetOwner, epochSequence: this.state.epochSequence, epoch: this.state.epoch, transition: this.state.transition, elapsedMs: Math.max(0, this.clock() - started), blockers, warnings } }
}

function sideTopology(inventory: DevboxGitRoamingInventory): DevboxGitRoamingStatus['localGit'] { const values = new Set(inventory.repositories.map((item) => item.topology)); return values.size === 0 ? 'missing' : values.size > 1 || values.has('mixed') ? 'mixed' : values.has('active') ? 'active' : 'parked' }
