import { createHash } from 'node:crypto'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { commandExecFileAsync } from '../shared/exec'
import { createDevboxError } from '../shared/devbox-errors'
import {
  MUTAGEN_RELEASE_PINS,
  MUTAGEN_VERSION,
  type MutagenReleasePlatform
} from './mutagen-release-pins'

export type MutagenResolverOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  arch?: string
  runVersion?: (binaryPath: string, env: NodeJS.ProcessEnv) => Promise<string>
  download?: (url: string) => Promise<Uint8Array>
  extract?: (archivePath: string, destination: string) => Promise<string>
  sha256?: (bytes: Uint8Array) => string
  log?: (message: string) => void
}

export const MUTAGEN_MANAGED_RELATIVE_PATH = join(
  '.local',
  'state',
  'devbox',
  'tools',
  `mutagen-${MUTAGEN_VERSION}`,
  'mutagen'
)

export function mutagenManagedBinaryPath(home = homedir()): string {
  return join(home, MUTAGEN_MANAGED_RELATIVE_PATH)
}

export async function resolveMutagenBinary(options: MutagenResolverOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  if (Object.hasOwn(env, 'DEVBOX_MUTAGEN_BINARY')) {
    return env.DEVBOX_MUTAGEN_BINARY ?? ''
  }

  const home = options.home ?? env.HOME ?? homedir()
  const managed = mutagenManagedBinaryPath(home)
  if (executable(managed)) {
    return managed
  }

  const pathBinary = findOnPath('mutagen', env.PATH)
  if (pathBinary && (await (options.runVersion ?? runVersion)(pathBinary, env)).match(/\b0\.18\.[0-9]+\b/)) {
    return pathBinary
  }

  const extracted = findExtractedMutagen(home)
  if (extracted) {
    return extracted
  }

  const platform = releasePlatform(options.platform ?? process.platform, options.arch ?? process.arch)
  if (!platform) {
    throw createDevboxError('operation_conflict', {
      message: `Mutagen ${MUTAGEN_VERSION} is not available for ${options.platform ?? process.platform}/${options.arch ?? process.arch}.`,
      context: { field: 'mutagen-platform' }
    })
  }
  return await installManagedMutagen(platform, managed, options)
}

function executable(path: string): boolean {
  try {
    return statSync(path).isFile() && (process.platform === 'win32' || accessSync(path, constants.X_OK) === undefined)
  } catch {
    return false
  }
}

function findOnPath(command: string, pathValue = process.env.PATH): string | undefined {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory) {continue}
    const candidate = join(directory, command)
    if (executable(candidate)) {return candidate}
  }
  return undefined
}

function findExtractedMutagen(home: string): string | undefined {
  const root = join(home, '.local', 'opt')
  try {
    return readdirSync(root)
      .filter((name) => name.startsWith('mutagen-'))
      .sort()
      .map((name) => join(root, name, 'extracted', 'mutagen'))
      .find(executable)
  } catch {
    return undefined
  }
}

async function runVersion(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await commandExecFileAsync(binaryPath, ['version'], { env })
    return `${result.stdout}\n${result.stderr}`
  } catch {
    return ''
  }
}

function releasePlatform(platform: NodeJS.Platform, arch: string): MutagenReleasePlatform | undefined {
  if (platform === 'darwin' && arch === 'arm64') {return 'darwin_arm64'}
  if (platform === 'darwin' && arch === 'x64') {return 'darwin_amd64'}
  if (platform === 'linux' && arch === 'x64') {return 'linux_amd64'}
  return undefined
}

async function installManagedMutagen(
  platform: MutagenReleasePlatform,
  managedPath: string,
  options: MutagenResolverOptions
): Promise<string> {
  if (executable(managedPath)) {return managedPath}
  const pin = MUTAGEN_RELEASE_PINS[platform]
  const download = options.download ?? downloadRelease
  const log = options.log ?? console.error
  log(`Devbox: installing Mutagen ${MUTAGEN_VERSION} for ${pin.lockPlatform}...`)
  const bytes = await download(pin.sourceUrl)
  const digest = (options.sha256 ?? ((value: Uint8Array) => createHash('sha256').update(value).digest('hex')))(bytes)
  if (digest !== pin.sha256) {
    throw createDevboxError('toolchain_digest_invalid', {
      message: `Mutagen ${pin.assetName} failed SHA256 verification.`,
      context: { field: `mutagen-release-${platform}` }
    })
  }

  const parent = dirname(managedPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(tmpdir(), 'devbox-mutagen-'))
  const archive = join(temporary, pin.assetName)
  const extracted = join(temporary, 'extracted')
  try {
    await writeFile(archive, bytes)
    const extract = options.extract ?? extractRelease
    const extractedBinary = await extract(archive, extracted)
    await copyFile(extractedBinary, managedPath)
    await chmod(managedPath, 0o755)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return managedPath
}

async function downloadRelease(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw createDevboxError('operation_conflict', {
      message: `Mutagen download failed with HTTP ${response.status}.`,
      context: { field: 'mutagen-download' }
    })
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function extractRelease(archivePath: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  try {
    await commandExecFileAsync('tar', ['-xzf', archivePath, '-C', destination])
  } catch (error) {
    throw createDevboxError('operation_conflict', {
      message: `Mutagen archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      context: { field: 'mutagen-extract' }
    })
  }
  const binary = findFile(destination, 'mutagen')
  if (!binary) {
    throw createDevboxError('operation_conflict', {
      message: 'Mutagen archive did not contain its executable.',
      context: { field: 'mutagen-extract' }
    })
  }
  return binary
}

function findFile(root: string, name: string): string | undefined {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isFile() && entry.name === name) {return path}
      if (entry.isDirectory()) {
        const nested = findFile(path, name)
        if (nested) {return nested}
      }
    }
  } catch {
    return undefined
  }
  return undefined
}
