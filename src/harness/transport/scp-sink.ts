import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ServerChannel } from 'ssh2'

function destinationFromCommand(command: string): string {
  const tokens = command.trim().split(/\s+/u)
  const marker = tokens.indexOf('-t')
  const candidate = marker >= 0 ? tokens[marker + 1] : undefined
  if (!candidate || candidate === '--') {
    return '.'
  }
  return candidate.replace(/^['"]|['"]$/gu, '')
}

function safeTarget(homeDirectory: string, command: string): string {
  const requested = destinationFromCommand(command)
  const target = resolve(homeDirectory, requested)
  if (target !== homeDirectory && !target.startsWith(`${homeDirectory}/`)) {
    throw new Error('fixture scp destination escaped the remote home')
  }
  return target
}

export function handleScpSink(
  channel: ServerChannel,
  homeDirectory: string,
  command: string
): void {
  let pending = Buffer.alloc(0)
  let bytesRemaining = 0
  let fileData = Buffer.alloc(0)
  let targetPath = safeTarget(homeDirectory, command)
  let finished = false

  const fail = (message: string): void => {
    if (finished) {
      return
    }
    finished = true
    channel.stderr.write(`${message}\n`)
    channel.exit(1)
    channel.end()
  }

  const acknowledge = (): void => {
    channel.write(Buffer.from([0]))
  }

  const finish = (): void => {
    if (finished) {
      return
    }
    finished = true
    channel.exit(0)
    channel.end()
  }

  const consume = (): void => {
    while (!finished) {
      if (bytesRemaining > 0) {
        const count = Math.min(bytesRemaining, pending.length)
        fileData = Buffer.concat([fileData, pending.subarray(0, count)])
        pending = pending.subarray(count)
        bytesRemaining -= count
        if (bytesRemaining > 0) {
          return
        }
        mkdirSync(join(targetPath, '..'), { recursive: true })
        writeFileSync(targetPath, fileData, { mode: 0o700 })
        fileData = Buffer.alloc(0)
        acknowledge()
        continue
      }

      const newline = pending.indexOf(10)
      if (newline < 0) {
        return
      }
      const header = pending.subarray(0, newline).toString('utf8')
      pending = pending.subarray(newline + 1)
      if (header.startsWith('C')) {
        const fields = header.split(' ')
        const size = Number(fields[1])
        const name = fields[2]
        if (!Number.isSafeInteger(size) || size < 0 || !name) {
          fail(`invalid scp file header: ${header}`)
          return
        }
        const requested = destinationFromCommand(command)
        targetPath = requested === '.' ? join(homeDirectory, basename(name)) : targetPath
        bytesRemaining = size
        acknowledge()
        continue
      }
      if (header.startsWith('T')) {
        acknowledge()
        continue
      }
      if (header === 'E') {
        acknowledge()
        finish()
        return
      }
      fail(`unsupported scp control record: ${header}`)
    }
  }

  channel.write(Buffer.from([0]))
  channel.on('data', (chunk: Buffer | string) => {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    consume()
  })
  channel.on('error', () => fail('scp channel error'))
}
