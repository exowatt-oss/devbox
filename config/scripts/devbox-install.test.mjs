import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Exercises scripts/devbox-install.sh end to end against a fake release: `uname`,
// `curl`, and `gh` are stubbed on PATH so platform detection, checksum
// verification, and the db/devbox install-name logic run without the network.

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const installer = path.join(repoRoot, 'scripts', 'devbox-install.sh')
const FOREIGN_DEVBOX = '#!/usr/bin/env bash\n# unrelated devbox CLI\n'

let root
let binDir
let releaseDir
let installDir

async function writeExecutable(file, body) {
  await writeFile(file, body)
  await chmod(file, 0o755)
}

async function writeRelease(targets) {
  const lines = []
  for (const target of targets) {
    const staging = path.join(root, `staging-${target}`)
    await mkdir(staging, { recursive: true })
    await writeExecutable(path.join(staging, 'devbox'), `#!/bin/sh\necho "devbox ${target}"\n`)
    await writeFile(path.join(staging, 'README.md'), `# Devbox ${target}\n`)
    const archive = `devbox-${target}.tar.gz`
    const result = spawnSync('tar', [
      '-czf',
      path.join(releaseDir, archive),
      '-C',
      staging,
      'devbox',
      'README.md'
    ])
    expect(result.status).toBe(0)
    const digest = createHash('sha256')
      .update(await readFile(path.join(releaseDir, archive)))
      .digest('hex')
    lines.push(`${digest}  ${archive}`)
  }
  await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

function runInstaller(unameS, unameM, releaseRepo) {
  return spawnSync('sh', [installer], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      DEVBOX_INSTALL_DIR: installDir,
      FAKE_UNAME_S: unameS,
      FAKE_UNAME_M: unameM,
      FAKE_RELEASE_DIR: releaseDir,
      ...(releaseRepo ? { DEVBOX_RELEASE_REPO: releaseRepo } : {})
    }
  })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'devbox-install-test-'))
  binDir = path.join(root, 'bin')
  releaseDir = path.join(root, 'release')
  installDir = path.join(root, 'install')
  await mkdir(binDir)
  await mkdir(releaseDir)
  await writeExecutable(
    path.join(binDir, 'uname'),
    '#!/bin/sh\ncase "$1" in -m) echo "$FAKE_UNAME_M" ;; *) echo "$FAKE_UNAME_S" ;; esac\n'
  )
  // No gh token: the installer falls back to plain release-download URLs.
  await writeExecutable(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n')
  await writeExecutable(
    path.join(binDir, 'curl'),
    `#!/bin/sh
out=
url=
while [ $# -gt 0 ]; do
  case "$1" in
    --output|--header|--proto) [ "$1" = --output ] && out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_RELEASE_DIR/requests"
cp "$FAKE_RELEASE_DIR/$(basename "$url")" "$out"
`
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('devbox-install.sh platform detection', () => {
  it.each([
    ['Darwin', 'arm64', 'darwin-arm64'],
    ['Darwin', 'x86_64', 'darwin-x64'],
    ['Linux', 'x86_64', 'linux-x64'],
    ['Linux', 'aarch64', 'linux-arm64'],
    ['Linux', 'arm64', 'linux-arm64']
  ])('%s %s installs %s', async (unameS, unameM, target) => {
    await writeRelease([target])
    const result = runInstaller(unameS, unameM)
    expect(result.stderr).not.toContain('unsupported platform')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Installed Devbox (${target}, latest)`)
    const installed = spawnSync(path.join(installDir, 'devbox'), [], { encoding: 'utf8' })
    expect(installed.stdout.trim()).toBe(`devbox ${target}`)
    expect(await readlink(path.join(installDir, 'db'))).toBe('devbox')
  })

  it('rejects an unsupported platform', async () => {
    await writeRelease(['linux-x64'])
    const result = runInstaller('Linux', 'riscv64')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unsupported platform Linux riscv64')
  })
})

describe('devbox-install.sh public release URLs', () => {
  it('downloads both assets from the public default without authentication', async () => {
    await writeRelease(['linux-x64'])
    expect(runInstaller('Linux', 'x86_64').status).toBe(0)
    const requests = await readFile(path.join(releaseDir, 'requests'), 'utf8')
    expect(requests).toContain('https://github.com/exowatt-oss/devbox/releases/latest/download/devbox-linux-x64.tar.gz')
    expect(requests).toContain('https://github.com/exowatt-oss/devbox/releases/latest/download/SHA256SUMS')
  })

  it('accepts a different release repository', async () => {
    await writeRelease(['linux-x64'])
    expect(runInstaller('Linux', 'x86_64', 'alice/devbox').status).toBe(0)
    expect(await readFile(path.join(releaseDir, 'requests'), 'utf8')).toContain('github.com/alice/devbox/releases/latest/download/')
  })

  it('rejects malformed repository overrides before any download', async () => {
    const result = runInstaller('Linux', 'x86_64', 'alice/devbox/extra')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must be a GitHub owner/repo')
    for (const invalid of ['alice:admin/devbox', 'alice/devbox:latest', 'alice/de:vbox']) {
      const rejected = runInstaller('Linux', 'x86_64', invalid)
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('must be a GitHub owner/repo')
    }
  })
})

describe('devbox-install.sh existing db files', () => {
  beforeEach(async () => {
    await writeRelease(['linux-arm64'])
    await mkdir(installDir)
  })

  it('refuses a foreign db script', async () => {
    const otherDb = '#!/bin/sh\necho some other db tool\n'
    await writeExecutable(path.join(installDir, 'devbox'), FOREIGN_DEVBOX)
    await writeExecutable(path.join(installDir, 'db'), otherDb)
    const result = runInstaller('Linux', 'aarch64')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('belong to another tool')
    expect(await readFile(path.join(installDir, 'db'), 'utf8')).toBe(otherDb)
  })

  it('leaves a regular db file alone', async () => {
    const otherDb = 'not a script\n'
    await writeFile(path.join(installDir, 'db'), otherDb)
    const result = runInstaller('Linux', 'aarch64')
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('leaving existing db')
    expect(await readFile(path.join(installDir, 'db'), 'utf8')).toBe(otherDb)
  })
})
