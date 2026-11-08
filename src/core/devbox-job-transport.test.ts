import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DevboxJobLogStore } from './devbox-job-logs'
import { DevboxJobSupervisor, hashDevboxJobSpec } from './devbox-job-supervisor'
import { createDevboxJobStartScript, DevboxJobTransport } from './devbox-job-transport'
import type { DevboxSshRunner } from '../shared/ssh-runner-types'

function fixture() {
  const spec = {
    id: 'job-1',
    command: ['phi'],
    cwd: '/remote',
    detached: true as const
  }
  const specHash = hashDevboxJobSpec(spec)
  const unitName = `devbox-job-1-${specHash.slice(0, 16)}.service`
  const record = [
    'job-1',
    specHash,
    unitName,
    `/sys/fs/cgroup/system.slice/${unitName}`,
    'running'
  ].join('\t')
  let createCalls = 0
  let findCalls = 0
  const runner: DevboxSshRunner = {
    command: vi.fn(async (command) => {
      if (command === 'uname -s') {return 'Linux\n'}
      findCalls += 1
      return findCalls === 1 ? '' : `${record}\n`
    }),
    script: vi.fn(async (script) => {
      if (script.includes('mkdir "$job"')) {
        createCalls += 1
        expect(script).toContain(`expected='${specHash}'`)
        throw new Error('simulated acknowledgement loss after remote launch')
      }
      return `started\t${record}\n`
    })
  }
  return { spec, record, runner, getCreateCalls: () => createCalls }
}

describe('DevboxJobTransport', () => {
  it('fails detached jobs fast on a macOS hub', async () => {
    const runner: DevboxSshRunner = { command: vi.fn(async () => 'Darwin\n'), script: vi.fn(async () => '') }
    const transport = new DevboxJobTransport({ runner, profileId: 'macmini' })
    await expect(transport.find('job-1')).rejects.toThrow('detached jobs require a systemd hub; macmini is a macOS hub — use db shell instead')
    expect(runner.script).not.toHaveBeenCalled()
  })

  it('adds the credential EnvironmentFile after filtered job environment options', () => {
    const spec = { id: 'job-1', command: ['bash', '-lc', 'echo ok'], cwd: '/remote', detached: true as const, environment: { SAFE: 'value' } }
    const specHash = hashDevboxJobSpec(spec)
    const unitName = `devbox-job-1-${specHash.slice(0, 16)}.service`
    const script = createDevboxJobStartScript(
      '/root/jobs',
      { id: spec.id, specHash, unitName, cgroupPath: `/sys/fs/cgroup/system.slice/${unitName}`, status: 'registered' },
      spec,
      '/dev/shm/devbox-profile-1.env'
    )
    expect(script).toContain('--setenv=\'SAFE=value\' --property=EnvironmentFile=\'/dev/shm/devbox-profile-1.env\'')
    expect(script).not.toContain('synthetic-credential-value')
  })

  it('keeps the remote create operation atomic across an acknowledgement crash', async () => {
    const f = fixture()
    const transport = new DevboxJobTransport({
      runner: f.runner,
      profileId: 'profile-1'
    })
    const supervisor = new DevboxJobSupervisor({
      transport,
      logs: new DevboxJobLogStore({
        rootDir: mkdtempSync(join(tmpdir(), 'devbox-transport-test-'))
      })
    })
    const first = await supervisor.launch(f.spec)
    const second = await supervisor.launch(f.spec)

    expect(first.attached).toBe(true)
    expect(second.attached).toBe(true)
    expect(first.job.status).toBe('running')
    expect(f.getCreateCalls()).toBe(1)
    expect(f.runner.command).toHaveBeenCalledTimes(4)
    expect(f.runner.script).toHaveBeenCalledOnce()
  })
})
