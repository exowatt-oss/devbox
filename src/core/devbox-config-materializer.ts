import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const DEVBOX_CONFIG_SCHEMA_VERSION = 1 as const
export const DEVBOX_PHI_ENV_ALLOWLIST = [
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
  'UV_INDEX_URL'
] as const

export type DevboxPhiEnvName = (typeof DEVBOX_PHI_ENV_ALLOWLIST)[number]
// oxfmt-ignore
export type DevboxConfigRoots = { localRoot: string; remoteRoot: string;
  localHome?: string; remoteHome?: string }
// oxfmt-ignore
export type DevboxConfigInput = { path: string; content: string; format?: 'text'|'json'|'shell' }
// oxfmt-ignore
export type DevboxCanonicalDocument ={ path: string; format: 'text'|'json'|'shell'; content: string}
// oxfmt-ignore
export type DevboxCanonicalIntent = { schemaVersion: typeof DEVBOX_CONFIG_SCHEMA_VERSION;
  documents: readonly DevboxCanonicalDocument[];
  phiEnv: Readonly<Partial<Record<DevboxPhiEnvName, string>>>;
  excludedPaths: readonly string[]; generatedPaths: readonly string[] }
// oxfmt-ignore
export type DevboxHostOverlay = { hostId: string; values: Readonly<Record<string, string>> }
// oxfmt-ignore
export type DevboxRenderedDocument = { path: string; content: string; excluded: boolean }
// oxfmt-ignore
export type DevboxSemanticConflict = { path: string;
  reason: 'changed-outside-overlay' | 'invalid-rendered-document' | 'placeholder-conflict';
  expected?: string; actual?: string }
// oxfmt-ignore
export type DevboxConfigParseResult = { status: 'ok' | 'conflict' | 'error';
  intent?: DevboxCanonicalIntent; conflicts: readonly DevboxSemanticConflict[];
  errors: readonly string[]; sourcedPhiEnv: false }
// oxfmt-ignore
export type DevboxMaterializationResult = { status: 'ok' | 'error';
  rendered: readonly DevboxRenderedDocument[]; excluded: readonly string[];
  generated: readonly { path: string; action: 'rebuild' }[]; errors: readonly string[] }
// oxfmt-ignore
export type DevboxPhiEnvResult = { status: 'ok' | 'error';
  declarations: Readonly<Partial<Record<DevboxPhiEnvName, string>>>; errors: readonly string[];
  sourced: false }
// oxfmt-ignore
export type DevboxConfigMaterializerOptions = { exists?: (path: string) => boolean;
  roots: DevboxConfigRoots; overlay: DevboxHostOverlay }

const secretPattern =
  /(^|\/)(?:auth\.json|(?:phi|secrets)\.env|\.mcp-auth|id_(?:rsa|ed25519)|.*\.(?:pem|key))$/i
const secretDirectoryPattern = /(^|\/)\.config\/gh(?:\/|$)/i
const generatedPattern = /(^|\/)(?:hub|packages|node_modules|\.pi\/agent\/generated)(?:\/|$)/i
const formatByExtension = { '.json': 'json', '.env': 'shell', '.sh': 'shell' } as const

const pathToken = (value: string, path: string, token: string): string =>
  value === path
    ? token
    : value.startsWith(`${path}/`)
      ? `${token}${value.slice(path.length)}`
      : value

const canonicalPaths = (value: string, roots: DevboxConfigRoots): string =>
  [
    [roots.localRoot, '${DEVBOX_LOCAL_ROOT}'],
    [roots.remoteRoot, '${DEVBOX_REMOTE_ROOT}'],
    [roots.localHome, '${DEVBOX_LOCAL_HOME}'],
    [roots.remoteHome, '${DEVBOX_REMOTE_HOME}']
  ].reduce((result, [path, token]) => (path ? pathToken(result, path!, token!) : result), value)

const renderPaths = (value: string, values: Readonly<Record<string, string>>): string =>
  value.replace(/\$\{DEVBOX_[A-Z_]+\}/g, (token) => values[token] ?? token)

const mapJson = (
  value: unknown,
  mapString: (value: string) => string,
  sortKeys: boolean
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => mapJson(item, mapString, sortKeys))
  }
  if (value && typeof value === 'object') {
    const entries = sortKeys
      ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      : Object.entries(value)
    return Object.fromEntries(
      entries.map(([key, item]) => [key, mapJson(item, mapString, sortKeys)])
    )
  }
  return typeof value === 'string' ? mapString(value) : value
}

const restoreValue = (value: string, reverse: Readonly<Record<string, string>>): string =>
  Object.entries(reverse).reduce((result, [path, token]) => pathToken(result, path, token), value)

const restoreJson = (value: unknown, values: Readonly<Record<string, string>>): unknown => {
  const reverse = Object.fromEntries(Object.entries(values).map(([token, path]) => [path, token]))
  return mapJson(value, (item) => restoreValue(item, reverse), false)
}

const shellMap = (content: string, mapper: (value: string) => string): string =>
  content
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*)(.*)$/.exec(line)
      return match ? `${match[1]}${mapper(match[2]!)}` : line
    })
    .join('\n')

const restoreShell = (content: string, values: Readonly<Record<string, string>>): string => {
  const reverse = Object.fromEntries(Object.entries(values).map(([token, path]) => [path, token]))
  return shellMap(content, (value) => restoreValue(value, reverse))
}

const stableJson = (value: unknown): string => JSON.stringify(value, null, 2)

export function classifyDevboxConfigPath(
  path: string
): 'portable' | 'excluded-from-generic-sync' | 'generated' {
  const normalized = path.replaceAll('\\', '/')
  if (secretPattern.test(normalized) || secretDirectoryPattern.test(normalized)) {
    return 'excluded-from-generic-sync'
  }
  return generatedPattern.test(normalized) ? 'generated' : 'portable'
}

export function parseDevboxPhiEnv(
  content: string,
  options: { exists?: (path: string) => boolean } = {}
): DevboxPhiEnvResult {
  const declarations: Partial<Record<DevboxPhiEnvName, string>> = {}
  const errors: string[] = []
  const exists = options.exists ?? existsSync
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || !DEVBOX_PHI_ENV_ALLOWLIST.includes(match[1] as DevboxPhiEnvName)) {
      errors.push(`line ${index + 1}: declaration is not allowlisted`)
      continue
    }
    const name = match[1] as DevboxPhiEnvName
    const rawValue = match[2]!
    if (/\$\(|`|;|&&|\|\||\n|\r/.test(rawValue)) {
      errors.push(`line ${index + 1}: shell expressions are not allowed`)
      continue
    }
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2')
    if (!value || /[<>]/.test(value)) {
      errors.push(`line ${index + 1}: invalid value`)
      continue
    }
    declarations[name] = value
    if (
      ['NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE'].includes(name) &&
      (!isAbsolute(value) || !exists(value))
    ) {
      errors.push(`${name}: declared CA path is missing or unreadable`)
    }
  }
  return { status: errors.length ? 'error' : 'ok', declarations, errors, sourced: false }
}

export function normalizeDevboxConfig(
  inputs: readonly DevboxConfigInput[],
  options: { roots: DevboxConfigRoots; exists?: (path: string) => boolean }
): { intent?: DevboxCanonicalIntent; errors: readonly string[] } {
  const errors: string[] = []
  const documents: DevboxCanonicalDocument[] = []
  const phiEnv: Partial<Record<DevboxPhiEnvName, string>> = {}
  const excluded: string[] = []
  const generated: string[] = []
  for (const input of inputs) {
    const category = classifyDevboxConfigPath(input.path)
    if (category === 'excluded-from-generic-sync') {
      excluded.push(input.path)
      if (input.path.endsWith('secrets.env')) {
        const parsed = parseDevboxPhiEnv(input.content, { exists: options.exists })
        Object.assign(phiEnv, parsed.declarations)
        errors.push(...parsed.errors)
      }
      continue
    }
    if (category === 'generated') {
      generated.push(input.path)
      continue
    }
    const extension = input.path.slice(input.path.lastIndexOf('.'))
    const format =
      input.format ?? formatByExtension[extension as keyof typeof formatByExtension] ?? 'text'
    try {
      const content =
        format === 'json'
          ? stableJson(
              mapJson(
                JSON.parse(input.content),
                (value) => canonicalPaths(value, options.roots),
                true
              )
            )
          : shellMap(input.content, (value) => canonicalPaths(value, options.roots))
      documents.push({ path: input.path, format, content })
    } catch {
      errors.push(`${input.path}: invalid ${format} document`)
    }
  }
  return errors.length
    ? { errors }
    : {
        intent: {
          schemaVersion: 1,
          documents: documents.sort((a, b) => a.path.localeCompare(b.path)),
          phiEnv,
          excludedPaths: excluded.sort(),
          generatedPaths: generated.sort()
        },
        errors
      }
}

export function renderDevboxConfig(
  intent: DevboxCanonicalIntent,
  overlay: DevboxHostOverlay
): readonly DevboxRenderedDocument[] {
  return intent.documents.map((document) => {
    let content = document.content
    if (document.format === 'json') {
      try {
        content = stableJson(
          mapJson(JSON.parse(content), (value) => renderPaths(value, overlay.values), false)
        )
      } catch {
        content = document.content
      }
    } else if (document.format === 'shell') {
      content = shellMap(content, (value) => renderPaths(value, overlay.values))
    }
    return { path: document.path, content, excluded: false }
  })
}

const restoreRenderedDocument = (
  document: DevboxConfigInput,
  values: Readonly<Record<string, string>>
): DevboxConfigInput => {
  let content = document.content
  if (document.format === 'json') {
    try {
      content = stableJson(restoreJson(JSON.parse(document.content), values))
    } catch {
      content = document.content
    }
  } else if (document.format === 'shell') {
    content = restoreShell(document.content, values)
  }
  return { ...document, path: document.path, content }
}

export function parseDevboxConfig(
  rendered: readonly DevboxConfigInput[],
  overlay: DevboxHostOverlay,
  options: {
    roots: DevboxConfigRoots
    exists?: (path: string) => boolean
    expected?: DevboxCanonicalIntent
  }
): DevboxConfigParseResult {
  const restored = rendered.map((document) => restoreRenderedDocument(document, overlay.values))
  const result = normalizeDevboxConfig(restored, { roots: options.roots, exists: options.exists })
  const invalidRendered = { path: '', reason: 'invalid-rendered-document' as const }
  const conflicts: DevboxSemanticConflict[] = result.errors.map((actual) => ({
    ...invalidRendered,
    actual
  }))
  if (result.intent && options.expected) {
    for (const expected of options.expected.documents) {
      const actual = result.intent.documents.find((document) => document.path === expected.path)
      if (!actual || actual.content !== expected.content) {
        conflicts.push({
          path: expected.path,
          reason: 'changed-outside-overlay',
          expected: expected.content,
          actual: actual?.content
        })
      }
    }
  }
  return {
    status: result.errors.length ? 'error' : conflicts.length ? 'conflict' : 'ok',
    ...(result.intent ? { intent: result.intent } : {}),
    conflicts,
    errors: result.errors,
    sourcedPhiEnv: false
  }
}

export class DevboxConfigMaterializer {
  constructor(private readonly options: DevboxConfigMaterializerOptions) {}
  normalize(inputs: readonly DevboxConfigInput[]) {
    return normalizeDevboxConfig(inputs, this.options)
  }
  render(intent: DevboxCanonicalIntent) {
    return renderDevboxConfig(intent, this.options.overlay)
  }
  parse(rendered: readonly DevboxConfigInput[], expected?: DevboxCanonicalIntent) {
    const { overlay, roots, exists } = this.options
    return parseDevboxConfig(rendered, overlay, { roots, exists, expected })
  }
  materialize(intent: DevboxCanonicalIntent): DevboxMaterializationResult {
    const errors: string[] = []
    for (const value of Object.values(intent.phiEnv)) {
      if (value && (value.includes('$(') || value.includes('`'))) {
        errors.push('secrets.env contains an executable expression')
      }
    }
    return {
      status: errors.length ? 'error' : 'ok',
      rendered: renderDevboxConfig(intent, this.options.overlay),
      excluded: intent.excludedPaths,
      generated: intent.generatedPaths.map((path) => ({ path, action: 'rebuild' as const })),
      errors
    }
  }
}
