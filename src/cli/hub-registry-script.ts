import { shellEscape } from '../ssh/shell-escape'
import type { HubRecord, SpokeRecord } from './hub-types'
import { HUB_REGISTRY_RELATIVE } from './hub-types'

export const HUB_READ_MARKERS = {
  root: '---ROOT---',
  hub: '---HUB---',
  spokes: '---SPOKES---',
  agents: '---AGENTS---',
  spokeRoots: '---SPOKE-ROOTS---',
  end: '---END---'
} as const

export type HubReadSnapshot = {
  rootState: 'missing' | 'exists-empty' | 'exists-nonempty' | 'exists-notdir' | 'unknown'
  hub: HubRecord | null
  spokes: readonly SpokeRecord[]
  liveAgentCount: number | null
  isSpokeRoot: boolean
}

type HubReadInput = {
  hubId: string
  remoteRoot: string
}

type HubWriteInput = {
  hubId: string
  hubRecord: HubRecord | null
  spokeRecord: SpokeRecord
}

export function buildHubReadScript(input: HubReadInput): string {
  const dir = registryDir(input.hubId)
  const remoteRoot = shellEscape(input.remoteRoot)
  const rootMarker = shellEscape(HUB_READ_MARKERS.root)
  const hubMarker = shellEscape(HUB_READ_MARKERS.hub)
  const spokesMarker = shellEscape(HUB_READ_MARKERS.spokes)
  const agentsMarker = shellEscape(HUB_READ_MARKERS.agents)
  const spokeRootsMarker = shellEscape(HUB_READ_MARKERS.spokeRoots)
  const endMarker = shellEscape(HUB_READ_MARKERS.end)
  const spokeRootsPath = shellEscape('.local/state/devbox/spoke-roots.json')
  const rootPattern = shellEscape(JSON.stringify(input.remoteRoot))
  return [
    'set -u',
    `root=${remoteRoot}`,
    `dir=${dir}`,
    `printf '%s\\n' ${rootMarker}`,
    'if [ ! -e "$root" ]; then printf \'%s\\n\' missing',
    'elif [ ! -d "$root" ]; then printf \'%s\\n\' exists-notdir',
    'elif [ -n "$(ls -A "$root" 2>/dev/null | sed -n \'1p\')" ]; then printf \'%s\\n\' exists-nonempty',
    'else printf \'%s\\n\' exists-empty; fi',
    `printf '%s\\n' ${hubMarker}`,
    'if [ -f "$dir/hub.json" ]; then cat "$dir/hub.json"; printf \'%s\\n\' \'\'; fi',
    `printf '%s\\n' ${spokesMarker}`,
    'if [ -d "$dir/spokes" ]; then for f in "$dir"/spokes/*.json; do [ -f "$f" ] || continue; cat "$f"; printf \'%s\\n\' \'\'; done; fi',
    `printf '%s\\n' ${agentsMarker}`,
    "if [ \"$(uname -s)\" = Darwin ]; then ps -axo command= 2>/dev/null; else ps -eo args= 2>/dev/null; fi | grep -F 'mutagen-agent' | grep -F 'synchronizer' | grep -vF grep | wc -l | tr -d ' '", 
    `printf '%s\\n' ${spokeRootsMarker}`,
    `if [ -f "$HOME"/${spokeRootsPath} ] && grep -F ${rootPattern} "$HOME"/${spokeRootsPath} >/dev/null 2>&1; then printf '%s\\n' yes; else printf '%s\\n' no; fi`,
    `printf '%s\\n' ${endMarker}`
  ].join('\n')
}

export function buildHubWriteScript(input: HubWriteInput): string {
  const dir = registryDir(input.hubId)
  const spokePath = `"$dir"/spokes/${shellEscape(`${input.spokeRecord.spokeId}.json`)}`
  const lines = [
    'set -eu',
    'umask 077',
    `dir=${dir}`,
    'mkdir -p "$dir/spokes"'
  ]
  if (input.hubRecord !== null) {
    // JSON.stringify emits one physical line, so it cannot contain a bare heredoc delimiter.
    lines.push(
      'if [ ! -e "$dir/hub.json" ]; then',
      '  f="$dir/hub.json"',
      "  cat > \"$f\" <<'DEVBOX_JSON'",
      JSON.stringify(input.hubRecord),
      'DEVBOX_JSON',
      'fi',
      'chmod 600 "$dir/hub.json"'
    )
  }
  lines.push(
    `f=${spokePath}`,
    "cat > \"$f\" <<'DEVBOX_JSON'",
    JSON.stringify(input.spokeRecord),
    'DEVBOX_JSON',
    'chmod 600 "$f"',
    "printf '%s\\n' 'HUB-WRITE-OK'"
  )
  return lines.join('\n')
}

export function parseHubReadOutput(output: string): HubReadSnapshot {
  let section: keyof typeof HUB_READ_MARKERS | 'none' = 'none'
  let rootState: HubReadSnapshot['rootState'] = 'unknown'
  let hub: HubRecord | null = null
  const spokes: SpokeRecord[] = []
  let liveAgentCount: number | null = null
  let isSpokeRoot = false
  for (const line of output.split(/\r?\n/)) {
    const marker = markerFor(line)
    if (marker !== undefined) {
      section = marker
      continue
    }
    if (section === 'root' && rootState === 'unknown' && isRootState(line)) {
      rootState = line
    } else if (section === 'hub' && hub === null && line.trim().length > 0) {
      const parsed = parseJson(line)
      if (isHubRecord(parsed)) {
        hub = parsed
      }
    } else if (section === 'spokes' && line.trim().length > 0) {
      const parsed = parseJson(line)
      if (isSpokeRecord(parsed)) {
        spokes.push(parsed)
      }
    } else if (section === 'agents' && liveAgentCount === null) {
      const count = Number.parseInt(line.trim(), 10)
      if (Number.isSafeInteger(count) && count >= 0) {
        liveAgentCount = count
      }
    } else if (section === 'spokeRoots' && line.trim() === 'yes') {
      isSpokeRoot = true
    }
  }
  return { rootState, hub, spokes, liveAgentCount, isSpokeRoot }
}

function registryDir(hubId: string): string {
  return `"$HOME"/${shellEscape(`${HUB_REGISTRY_RELATIVE}/${hubId}`)}`
}

function markerFor(line: string): keyof typeof HUB_READ_MARKERS | undefined {
  const entries = Object.entries(HUB_READ_MARKERS) as [keyof typeof HUB_READ_MARKERS, string][]
  return entries.find(([, value]) => line.trim() === value)?.[0]
}

function isRootState(value: string): value is HubReadSnapshot['rootState'] {
  return value === 'missing' || value === 'exists-empty' || value === 'exists-nonempty' || value === 'exists-notdir'
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function isHubRecord(value: unknown): value is HubRecord {
  if (!isRecord(value) || !isStringFields(value, ['hubId', 'root', 'host', 'user', 'createdAt', 'devboxVersion'])) {
    return false
  }
  return isRecord(value.createdBy) && isStringFields(value.createdBy, ['spokeId', 'hostname'])
}

function isSpokeRecord(value: unknown): value is SpokeRecord {
  return isRecord(value) && isStringFields(value, ['spokeId', 'hostname', 'platform', 'username', 'localRoot', 'profileId', 'devboxVersion', 'registeredAt', 'lastSeenAt'])
}

function isStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
