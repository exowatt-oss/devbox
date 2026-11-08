import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'
import type { HubRecord, HubView, SpokeRecord } from './hub-types'
import { buildHubReadScript, buildHubWriteScript, parseHubReadOutput } from './hub-registry-script'
import type { HubReadSnapshot } from './hub-registry-script'
import { hubIdForRoot } from './spoke-identity'

export type HubRegistryTarget = {
  ssh: DevboxSshRunner
  host: string
  port: number
  user: string
  remoteRoot: string
}

export type SpokeFacts = {
  spokeId: string
  hostname: string
  platform: string
  username: string
  localRoot: string
  profileId: string
  devboxVersion: string
}

export type HubReadResult = HubView & {
  rootState: HubReadSnapshot['rootState']
  isSpokeRoot: boolean
}

type RegistryOptions = {
  now?: () => Date
  timeoutMs?: number
}

export async function readHub(target: HubRegistryTarget, spokeId: string, timeoutMs = 15_000): Promise<HubReadResult> {
  const hubId = hubIdForRoot(target.remoteRoot)
  try {
    const output = await target.ssh.script(buildHubReadScript({ hubId, remoteRoot: target.remoteRoot }), timeoutMs)
    const snapshot = parseHubReadOutput(output)
    return toHubReadResult(target, spokeId, snapshot)
  } catch (error) {
    return {
      reachable: false,
      hubId,
      root: target.remoteRoot,
      host: target.host,
      port: target.port,
      user: target.user,
      registered: false,
      record: null,
      spokes: [],
      thisSpokeId: spokeId,
      liveAgentCount: null,
      rootState: 'unknown',
      isSpokeRoot: false,
      detail: singleLineError(error)
    }
  }
}

export async function registerHubAndSpoke(
  target: HubRegistryTarget,
  facts: SpokeFacts,
  options: RegistryOptions = {}
): Promise<HubReadResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const initial = await readHub(target, facts.spokeId, timeoutMs)
  if (!initial.reachable) {
    throw createDevboxError('operation_conflict', {
      message: initial.detail ?? `Unable to reach hub host '${target.host}'.`,
      context: { field: 'hub-unreachable' }
    })
  }
  if (initial.isSpokeRoot) {
    throw createDevboxError('operation_conflict', {
      message: `Devbox never syncs local ↔ local: ${target.remoteRoot} on ${target.host} is itself a Devbox spoke root. Connect to that machine's hub instead.`,
      context: { field: 'hub-root-is-a-spoke' }
    })
  }
  const timestamp = (options.now ?? (() => new Date()))().toISOString()
  const hubRecord = initial.record ?? {
    hubId: initial.hubId,
    root: target.remoteRoot,
    host: target.host,
    user: target.user,
    createdAt: timestamp,
    createdBy: { spokeId: facts.spokeId, hostname: facts.hostname },
    devboxVersion: facts.devboxVersion
  }
  const existingSpoke = initial.spokes.find((spoke) => spoke.spokeId === facts.spokeId)
  const spokeRecord = toSpokeRecord(facts, existingSpoke?.registeredAt ?? timestamp, timestamp)
  await writeHubAndSpoke(target, initial.hubId, hubRecord, spokeRecord, timeoutMs)
  const result = await readHub(target, facts.spokeId, timeoutMs)
  if (!result.reachable) {
    throw createDevboxError('operation_conflict', {
      message: result.detail ?? `Unable to reach hub host '${target.host}'.`,
      context: { field: 'hub-unreachable' }
    })
  }
  return result
}

export async function touchSpoke(
  target: HubRegistryTarget,
  facts: SpokeFacts,
  options: RegistryOptions = {}
): Promise<HubReadResult | null> {
  const timeoutMs = options.timeoutMs ?? 15_000
  let initial: HubReadResult
  try {
    initial = await readHub(target, facts.spokeId, timeoutMs)
  } catch {
    return null
  }
  if (!initial.reachable || !initial.registered) {
    return initial
  }
  const existingSpoke = initial.spokes.find((spoke) => spoke.spokeId === facts.spokeId)
  if (existingSpoke === undefined) {
    return initial
  }
  try {
    const timestamp = (options.now ?? (() => new Date()))().toISOString()
    const spokeRecord = toSpokeRecord(facts, existingSpoke.registeredAt, timestamp)
    await writeHubAndSpoke(target, initial.hubId, null, spokeRecord, timeoutMs)
    return await readHub(target, facts.spokeId, timeoutMs)
  } catch {
    return initial
  }
}

function toHubReadResult(target: HubRegistryTarget, spokeId: string, snapshot: HubReadSnapshot): HubReadResult {
  return {
    reachable: true,
    hubId: hubIdForRoot(target.remoteRoot),
    root: target.remoteRoot,
    host: target.host,
    port: target.port,
    user: target.user,
    registered: snapshot.hub !== null,
    record: snapshot.hub,
    spokes: snapshot.spokes,
    thisSpokeId: spokeId,
    liveAgentCount: snapshot.liveAgentCount,
    rootState: snapshot.rootState,
    isSpokeRoot: snapshot.isSpokeRoot
  }
}

function toSpokeRecord(facts: SpokeFacts, registeredAt: string, lastSeenAt: string): SpokeRecord {
  return { ...facts, registeredAt, lastSeenAt }
}

async function writeHubAndSpoke(
  target: HubRegistryTarget,
  hubId: string,
  hubRecord: HubRecord | null,
  spokeRecord: SpokeRecord,
  timeoutMs: number
): Promise<void> {
  let output: string
  try {
    output = await target.ssh.script(buildHubWriteScript({ hubId, hubRecord, spokeRecord }), timeoutMs)
  } catch (error) {
    throw createDevboxError('operation_conflict', {
      message: singleLineError(error),
      context: { field: 'hub-write' }
    })
  }
  if (!output.split(/\r?\n/).some((line) => line.trim() === 'HUB-WRITE-OK')) {
    throw createDevboxError('operation_conflict', {
      message: 'The remote hub registry did not confirm its write.',
      context: { field: 'hub-write' }
    })
  }
}

function singleLineError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, ' ').trim() || 'Unknown SSH failure.'
}
