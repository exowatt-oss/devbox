import { appendFile, chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const seaRoot = path.join(repoRoot, 'dist', 'sea')
const releaseRoot = path.join(repoRoot, 'dist', 'release')
const entry = process.env.DEVBOX_SEA_ENTRY
  ? path.resolve(process.env.DEVBOX_SEA_ENTRY)
  : path.join(repoRoot, 'src', 'cli', 'index.ts')
const esbuildBin = path.join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild')
const postjectBin = path.join(repoRoot, 'node_modules', 'postject', 'dist', 'cli.js')

function fail(message) {
  throw new Error(`SEA build failed: ${message}`)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
}

function platformTarget() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    fail(`unsupported operating system ${process.platform}; expected darwin or linux`)
  }
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    fail(`unsupported architecture ${process.arch}; expected arm64 or x64`)
  }
  return `${process.platform}-${process.arch}`
}

async function main() {
  const target = platformTarget()
  const seaEntry = path.join(seaRoot, 'devbox-sea.cjs')
  const seaConfig = path.join(seaRoot, 'sea-config.json')
  const blob = path.join(seaRoot, 'devbox.blob')
  const executable = path.join(releaseRoot, `devbox-${target}`)

  await mkdir(seaRoot, { recursive: true })
  await mkdir(releaseRoot, { recursive: true })
  await rm(seaEntry, { force: true })
  await rm(seaConfig, { force: true })
  await rm(blob, { force: true })
  await rm(executable, { force: true })

  run(esbuildBin, [
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node24',
    `--outfile=${seaEntry}`
  ])
  // The CLI's ESM entry guard is intentionally false in a CJS SEA bundle. Invoke
  // the exported main function explicitly so --version and normal commands run.
  await appendFile(seaEntry, '\nmain();\n')

  await writeFile(
    seaConfig,
    `${JSON.stringify(
      {
        main: seaEntry,
        output: blob,
        disableExperimentalSEAWarning: true
      },
      null,
      2
    )}\n`
  )

  run(process.execPath, ['--experimental-sea-config', seaConfig])
  await copyFile(process.execPath, executable)
  await chmod(executable, 0o755)

  if (process.platform === 'darwin') {
    run('codesign', ['--remove-signature', executable])
  }

  // Node 24 embeds the complete postject fuse in its executable. The short
  // NODE_SEA prefix occurs more than once and is rejected by postject.
  const postjectArgs = [
    executable,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ]
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA')
  }
  run(process.execPath, [postjectBin, ...postjectArgs])

  if (process.platform === 'darwin') {
    const identity = process.env.MAC_SIGN_IDENTITY || '-'
    run('codesign', ['--sign', identity, executable])
  }

  run(executable, ['--version'])
  console.log(`SEA executable ready: ${path.relative(repoRoot, executable)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
