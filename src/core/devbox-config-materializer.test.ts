import { describe, expect, it } from 'vitest'
import {
  DevboxConfigMaterializer,
  classifyDevboxConfigPath,
  normalizeDevboxConfig,
  parseDevboxConfig,
  parseDevboxPhiEnv,
  renderDevboxConfig,
  type DevboxCanonicalIntent,
  type DevboxConfigInput
} from './devbox-config-materializer'

const roots = {
  localRoot: '/Users/sample/project',
  remoteRoot: '/home/sample/project',
  localHome: '/Users/sample',
  remoteHome: '/home/sample'
}
const overlay = {
  hostId: 'main-sample-devbox',
  values: {
    '${DEVBOX_LOCAL_ROOT}': '/Users/sample/project',
    '${DEVBOX_REMOTE_ROOT}': '/home/sample/project',
    '${DEVBOX_LOCAL_HOME}': '/Users/sample',
    '${DEVBOX_REMOTE_HOME}': '/home/sample'
  }
}
const documents: DevboxConfigInput[] = [
  {
    path: '/Users/sample/project/.pi/settings.json',
    format: 'json',
    content: JSON.stringify({
      cwd: '/Users/sample/project',
      cache: '/Users/sample/.cache',
      nested: { remote: '/home/sample/project/tools' }
    })
  },
  {
    path: '/Users/sample/project/.bashrc.d/devbox.sh',
    format: 'shell',
    content: 'export DEVBOX_ROOT=/Users/sample/project\nexport DEVBOX_REMOTE=/home/sample/project'
  }
]

describe('DevboxConfigMaterializer', () => {
  it('normalizes path-bearing JSON and shell config, then round-trips without rewrite drift', () => {
    const normalized = normalizeDevboxConfig(documents, { roots })
    expect(normalized.errors).toEqual([])
    const intent = normalized.intent!
    expect(intent.documents[0]?.content).toContain('${DEVBOX_LOCAL_ROOT}')
    expect(intent.documents[0]?.content).toContain('${DEVBOX_REMOTE_ROOT}')
    const rendered = renderDevboxConfig(intent, overlay)
    const parsed = parseDevboxConfig(
      rendered.map(({ path, content }) => ({ path, content })),
      overlay,
      { roots, expected: intent }
    )
    expect(parsed.status).toBe('ok')
    expect(parsed.intent).toEqual(intent)
    expect(renderDevboxConfig(parsed.intent!, overlay)).toEqual(rendered)
  })

  it('surfaces semantic edits rather than overwriting them during parse', () => {
    const intent = normalizeDevboxConfig(documents, { roots }).intent!
    const rendered = renderDevboxConfig(intent, overlay).map((document) =>
      document.path.endsWith('devbox.sh')
        ? { ...document, content: `${document.content}\nexport EXTRA=changed` }
        : document
    )
    const parsed = parseDevboxConfig(rendered, overlay, { roots, expected: intent })
    expect(parsed.status).toBe('conflict')
    expect(parsed.conflicts[0]?.reason).toBe('changed-outside-overlay')
  })

  it('parses secrets.env structurally without sourcing and hard-fails a missing declared CA path', () => {
    const source =
      'export SSL_CERT_FILE=/trusted/ca.pem\nUV_INDEX_URL=https://packages.example.test/simple\nsource ~/.profile\n'
    const parsed = parseDevboxPhiEnv(source, { exists: (path) => path === '/trusted/ca.pem' })
    expect(parsed.status).toBe('error')
    expect(parsed.sourced).toBe(false)
    expect(parsed.declarations.SSL_CERT_FILE).toBe('/trusted/ca.pem')
    expect(parsed.errors.some((error) => error.includes('allowlisted'))).toBe(true)
    const missing = parseDevboxPhiEnv('SSL_CERT_FILE=/missing/ca.pem\n', { exists: () => false })
    expect(missing.errors[0]).toContain('missing or unreadable')
    const result = normalizeDevboxConfig(
      [{ path: '/home/sample/.pi/agent/secrets.env', content: 'SSL_CERT_FILE=/missing/ca.pem' }],
      { roots, exists: () => false }
    )
    expect(result.intent).toBeUndefined()
    expect(result.errors[0]).toContain('missing or unreadable')
  })

  it('excludes secret material and marks generated hub/package state for rebuild', () => {
    expect(classifyDevboxConfigPath('/home/sample/.pi/auth.json')).toBe(
      'excluded-from-generic-sync'
    )
    expect(classifyDevboxConfigPath('/home/sample/.pi/agent/secrets.env')).toBe(
      'excluded-from-generic-sync'
    )
    expect(classifyDevboxConfigPath('/home/sample/.config/gh/hosts.yml')).toBe(
      'excluded-from-generic-sync'
    )
    expect(classifyDevboxConfigPath('/home/sample/.ssh/id_ed25519')).toBe(
      'excluded-from-generic-sync'
    )
    expect(classifyDevboxConfigPath('/home/sample/.pi/agent/hub/index.json')).toBe('generated')
    const input = [
      ...documents,
      { path: '/home/sample/.pi/auth.json', content: '{"token":"secret"}' },
      { path: '/home/sample/.pi/agent/hub/index.json', content: '{}' }
    ]
    const intent = normalizeDevboxConfig(input, { roots }).intent!
    expect(intent.documents.map(({ path }) => path)).not.toContain('/home/sample/.pi/auth.json')
    const materialized = new DevboxConfigMaterializer({ roots, overlay }).materialize(intent)
    expect(materialized.excluded).toContain('/home/sample/.pi/auth.json')
    expect(materialized.generated).toEqual([
      { path: '/home/sample/.pi/agent/hub/index.json', action: 'rebuild' }
    ])
  })

  it('keeps the canonical intent value-free and reports a stable parse result', () => {
    const intent: DevboxCanonicalIntent = {
      schemaVersion: 1,
      documents: [],
      phiEnv: {},
      excludedPaths: ['auth.json'],
      generatedPaths: []
    }
    const materializer = new DevboxConfigMaterializer({ roots, overlay })
    expect(materializer.materialize(intent)).toMatchObject({
      status: 'ok',
      rendered: [],
      excluded: ['auth.json']
    })
    expect(JSON.stringify(intent)).not.toContain('secret')
    expect(parseDevboxConfig([], overlay, { roots, expected: intent })).toMatchObject({
      status: 'ok',
      sourcedPhiEnv: false
    })
  })
})
