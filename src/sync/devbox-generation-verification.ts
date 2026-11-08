import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DevboxWorkspaceGeneration,
  DevboxWorkspaceManifest
} from './devbox-workspace-generation-manager'
import { createManifest, digest, readManifest, READY_FILE } from './devbox-generation-manifest'

async function isUsable(root: string): Promise<boolean> {
  const expected = await readManifest(root)
  if (!expected) {
    return false
  }
  try {
    const readyMarker = await readFile(join(root, READY_FILE), 'utf8')
    return readyMarker.trim() === digest(expected)
  } catch {
    return false
  }
}

export async function verifyManifestTree(
  root: string,
  expected: DevboxWorkspaceManifest
): Promise<boolean> {
  const actual = await createManifest(root, expected.createdAt, true)
  return (
    actual.treeHash === expected.treeHash &&
    JSON.stringify(actual.entries) === JSON.stringify(expected.entries)
  )
}

export async function isGenerationUsable(root: string): Promise<boolean> {
  return isUsable(root)
}

export async function verifyGenerationRoot(root: string): Promise<boolean> {
  const expected = await readManifest(root)
  if (!expected) {
    return false
  }
  if (!(await isUsable(root))) {
    return false
  }
  return verifyManifestTree(root, expected)
}

export async function listVerifiedGenerations(
  generationsRoot: string
): Promise<readonly DevboxWorkspaceGeneration[]> {
  await mkdir(generationsRoot, { recursive: true, mode: 0o700 })
  const result: DevboxWorkspaceGeneration[] = []
  const names = await readdir(generationsRoot)

  for (const name of names) {
    const root = join(generationsRoot, name)
    if (!name.startsWith('generation-')) {
      continue
    }
    if (!(await verifyGenerationRoot(root))) {
      continue
    }

    const expected = await readManifest(root)
    if (expected) {
      result.push({
        id: name,
        root,
        manifest: expected,
        manifestHash: digest(expected),
        verified: true,
        lease: null
      })
    }
  }

  return result.sort((left, right) => left.manifest.createdAt - right.manifest.createdAt)
}
