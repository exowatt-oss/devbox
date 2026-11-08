import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const packagePath = path.join(repoRoot, 'package.json')
const versionSourcePath = path.join(repoRoot, 'src', 'cli', 'version.ts')
const tag = process.argv[2]

async function main() {
  if (!tag || !/^v\d+\.\d+\.\d+$/u.test(tag)) {
    throw new Error(`Release tag must match v<major>.<minor>.<patch>; received ${tag ?? 'nothing'}`)
  }

  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const expectedTag = `v${packageJson.version}`
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match package.json version tag ${expectedTag}`)
  }

  // Why: `db --version` reads a hardcoded DEVBOX_VERSION, not package.json, so a
  // release could ship reporting the previous version (v0.2.4 shipped as 0.2.3).
  // Fail the release instead of letting the binary lie about what it is.
  const versionSource = await readFile(versionSourcePath, 'utf8')
  const declared = /DEVBOX_VERSION\s*=\s*'([^']+)'/u.exec(versionSource)?.[1]
  if (declared !== packageJson.version) {
    throw new Error(
      `src/cli/version.ts declares DEVBOX_VERSION '${declared ?? 'nothing'}' but package.json version is '${packageJson.version}'`
    )
  }

  console.log(`Release tag OK: ${tag} (DEVBOX_VERSION ${declared})`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
