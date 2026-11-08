import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const releaseDirectory = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist', 'release'))
const checksumName = 'SHA256SUMS'

async function sha256(filePath) {
  const contents = await readFile(filePath)
  return createHash('sha256').update(contents).digest('hex')
}

async function main() {
  const entries = await readdir(releaseDirectory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== checksumName)
    .map((entry) => entry.name)
    .sort()

  if (files.length === 0) {
    throw new Error(`No release files found in ${releaseDirectory}`)
  }

  const lines = []
  for (const name of files) {
    lines.push(`${await sha256(path.join(releaseDirectory, name))}  ${name}`)
  }
  await writeFile(path.join(releaseDirectory, checksumName), `${lines.join('\n')}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
