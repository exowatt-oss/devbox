import { connect, createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  allocateFreeLocalPort,
  buildSshPortForwardArgv,
  createSshPortForwarder
} from './port-forward'

const fakeSsh = fileURLToPath(new URL('./__fixtures__/fake-ssh.sh', import.meta.url))
const endpoint = {
  host: 'devbox.example.test',
  port: 2222,
  username: 'alice',
  knownHostsFile: '/tmp/devbox-known_hosts',
  extraOptions: ['LogLevel=ERROR']
} as const

describe('SSH port forwarding', () => {
  it('allocates an available loopback port', async () => {
    const port = await allocateFreeLocalPort()
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
      })
      expect(server.address()).toMatchObject({ address: '127.0.0.1', port })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('builds hardened -N -L argv with one remote forwarding argument', () => {
    const args = buildSshPortForwardArgv(endpoint, 43210, '127.0.0.1', 8080)

    expect(args).toEqual([
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ConnectTimeout=30',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:43210:127.0.0.1:8080',
      '-o',
      'UserKnownHostsFile=/tmp/devbox-known_hosts',
      '-o',
      'LogLevel=ERROR',
      '-p',
      '2222',
      '--',
      'alice@devbox.example.test'
    ])
  })

  it('waits for the local listener and closes the spawned SSH child', async () => {
    const forwarder = createSshPortForwarder(endpoint, { sshBinary: fakeSsh })
    const forward = await forwarder.openForward({
      remoteHost: '127.0.0.1',
      remotePort: 8080,
      label: 'dev server'
    })

    expect(forward.entry).toMatchObject({
      id: 'pf-1',
      connectionId: 'alice@devbox.example.test:2222',
      localPort: expect.any(Number),
      remoteHost: '127.0.0.1',
      remotePort: 8080,
      label: 'dev server'
    })
    await probe(forward.entry.localPort)
    await forward.close()
    await expect(probe(forward.entry.localPort)).rejects.toBeDefined()
  })

  it('rejects early SSH exits with stderr', async () => {
    const forwarder = createSshPortForwarder(
      { ...endpoint, host: 'fail.example' },
      { sshBinary: fakeSsh }
    )

    await expect(
      forwarder.openForward({ remoteHost: '127.0.0.1', remotePort: 8080 })
    ).rejects.toMatchObject({
      message: 'SSH port forward failed (exit 23): fake ssh connection failure'
    })
  })
})

function probe(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', reject)
  })
}
