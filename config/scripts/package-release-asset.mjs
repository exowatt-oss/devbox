import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const releaseRoot = path.join(repoRoot, 'dist', 'release')
const allowedTargets = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'])
const licenseName = /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/iu

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if (result.error) {throw result.error}
  if (result.status !== 0) {throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)}
}

async function readLicense(directory) {
  const names = (await readdir(directory)).filter((name) => licenseName.test(name)).sort()
  if (names.length === 0) {return null}
  return readFile(path.join(directory, names[0]), 'utf8')
}

async function dependencyNotices() {
  const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const notices = []
  const visited = new Set()
  async function visit(name, modulesDirectory, optional = false) {
    const modulePath = path.join(modulesDirectory, ...name.split('/'))
    let directory
    try {directory = await realpath(modulePath)}
    catch (error) {
      if (optional && error?.code === 'ENOENT') {return}
      throw new Error(`Missing production dependency ${name} at ${modulePath}: ${error.message}`)
    }
    if (visited.has(directory)) {return}
    visited.add(directory)
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    const license = await readLicense(directory)
    if (!license) {throw new Error(`Missing license for bundled dependency ${name} at ${directory}`)}
    notices.push(`===== ${pkg.name}@${pkg.version} (${pkg.license ?? 'see license text'}) =====\n${license.trimEnd()}\n`)
    // pnpm links each dependency beside the real package directory, not inside it.
    const dependencyParent = path.dirname(directory)
    for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) {
      await visit(dep, dependencyParent)
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}).sort()) {
      if (!(dep in (pkg.dependencies ?? {}))) {await visit(dep, dependencyParent, true)}
    }
  }
  for (const dep of Object.keys(root.dependencies ?? {}).sort()) {await visit(dep, path.join(repoRoot, 'node_modules'))}
  return notices.sort().join('\n')
}

async function nodeLicense() {
  // Node SEA embeds the runtime. Official Node installations ship LICENSE
  // alongside their root; process.execPath resolves Homebrew's bin symlinks.
  const binary = await realpath(process.execPath)
  for (const directory of [path.dirname(binary), path.resolve(path.dirname(binary), '..')]) {
    const license = await readLicense(directory)
    if (license) {return `===== Node.js ${process.version} =====\n${license.trimEnd()}\n`}
  }
  if (process.env.CI) {throw new Error(`Node.js ${process.version} LICENSE not found in the build installation`)}
  const source = process.release.sourceUrl ?? `https://nodejs.org/download/release/${process.version}/`
  return `===== Node.js ${process.version} =====\nRuntime license was unavailable in the build installation. Obtain the LICENSE from ${source}.\n`
}

async function main() {
  const target = process.argv[2]
  if (!allowedTargets.has(target)) {
    throw new Error(`Expected target ${[...allowedTargets].join(', ')} as argv[2]; received ${target ?? 'nothing'}`)
  }
  const executable = path.join(releaseRoot, `devbox-${target}`)
  const archive = path.join(releaseRoot, `devbox-${target}.tar.gz`)
  const staging = await mkdtemp(path.join(os.tmpdir(), 'devbox-release-'))

  try {
    await mkdir(releaseRoot, { recursive: true })
    await copyFile(executable, path.join(staging, 'devbox'))
    await chmod(path.join(staging, 'devbox'), 0o755)
    for (const name of ['LICENSE', 'NOTICE']) {await copyFile(path.join(repoRoot, name), path.join(staging, name))}
    await writeFile(path.join(staging, 'THIRD-PARTY-NOTICES'),
      `Licenses for the bundled Node.js runtime and production dependencies.\n\n${await nodeLicense()}\n${await dependencyNotices()}`)
    await writeFile(path.join(staging, 'README.md'),
      `# Devbox ${target}\n\nThis archive contains the Devbox executable for ${target}.\n\nInstall it with the release installer or place the devbox executable on your PATH.\nSee LICENSE, NOTICE and THIRD-PARTY-NOTICES for licensing information.\n`)
    const names = ['devbox', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES']
    for (const name of names) {await utimes(path.join(staging, name), 0, 0)}
    const plainArchive = path.join(staging, 'release.tar')
    await rm(archive, { force: true })
    run('tar', ['-cf', plainArchive, '-C', staging, ...names])
    // gzip -n removes its filename/timestamp header; sorted notices and fixed mtimes
    // make repeat packaging of the same executable byte-for-byte reproducible.
    run('sh', ['-c', 'gzip -n -c "$1" > "$2"', 'sh', plainArchive, archive])
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  console.log(`Release asset ready: ${path.relative(repoRoot, archive)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
