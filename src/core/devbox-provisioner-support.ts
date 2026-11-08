import { createHash } from 'node:crypto'
import { createDevboxError } from '../shared/devbox-errors'
import type { DevboxProvisionStageId, DevboxProvisionState } from './devbox-provisioner-types'

export const STAGES: readonly DevboxProvisionStageId[] = [
  'backup',
  'authorization',
  'toolchain',
  'generation',
  'config',
  'shell',
  'credential-metadata',
  'verify'
]

export const json = (v: unknown): string => {
  if (Array.isArray(v)) {
    return `[${v.map(json).join(',')}]`
  }
  if (v && typeof v === 'object') {
    const value = v as Record<string, unknown>
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${json(value[key])}`)
      .join(',')
    return `{${entries}}`
  }
  return JSON.stringify(v)
}

export const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex')

export const bin = (v: string | Uint8Array): Uint8Array => {
  if (typeof v === 'string') {
    return new Uint8Array(Buffer.from(v))
  }
  return new Uint8Array(v)
}

export const stop = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createDevboxError('cancelled')
  }
}

export const stateOf = (v: unknown): DevboxProvisionState => {
  if (v && typeof v === 'object') {
    return v as DevboxProvisionState
  }
  return {}
}

export const backupScript = `set -Eeuo pipefail
backup=$1
shift
mkdir -p "$backup"
for path in "$@"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      name=$(printf '%s' "$path" | sha256sum | cut -d' ' -f1)
    else
      name=$(printf '%s' "$path" | shasum -a 256 | cut -d' ' -f1)
    fi
    cp -a "$path" "$backup/$name"
    printf '%s\\t%s\\n' "$name" "$path" >> "$backup/manifest"
  fi
done
`

export const generationScript = `set -Eeuo pipefail
root=$1
manifest=$2
current=$3
mkdir -p "$root/$manifest"
printf '%s\\n' "$manifest" > "$root/$manifest/MANIFEST.sha256"
tmp="$current.tmp.$manifest"
ln -sfn "$root/$manifest" "$tmp"
rm -f "$current"
mv -f "$tmp" "$current"
`

export const restoreScript = `set -Eeuo pipefail
backup=$1
while IFS=$(printf '\\t') read -r name path; do
  if [ -e "$backup/$name" ]; then
    rm -rf "$path"
    cp -a "$backup/$name" "$path"
  fi
done < "$backup/manifest"
`
