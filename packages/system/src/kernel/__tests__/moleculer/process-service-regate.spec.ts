/**
 * planning#713 — EVERY way the hub stops a runner (`stop`, `restart`,
 * `restartAll`) re-gates that runner's devices first, through one helper, so an
 * offline written while the runner tears down is held. Fake-spawn style of
 * process-service-restart-race.spec.ts.
 */
import * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ServiceBroker } from 'moleculer'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetStateRefreshPolicyRegistryForTests,
  childRefreshSource,
  getStateRefreshPolicyRegistry,
} from '../../state-refresh-policies.js'
import { createProcessService } from '../../moleculer/process-service.js'
import { inertProcessGroups } from './inert-process-groups.js'

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
  exitCode: number | null
  signalCode: string | null
}

function makeFakeChild(pid: number): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.pid = pid
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.exitCode = null
  ee.signalCode = null
  ee.kill = (sig?: string) => {
    if (ee.exitCode !== null || ee.signalCode !== null) return false
    setImmediate(() => {
      ee.signalCode = sig ?? 'SIGTERM'
      ee.emit('exit', null, ee.signalCode)
    })
    return true
  }
  return ee
}

describe('process-service re-gates a runner before it stops it (planning#713)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-regate-'))
  let pidCounter = 80000
  const fakeSpawn = (
    _command: string,
    _args: readonly string[],
    opts: cp.SpawnOptions,
  ): cp.ChildProcess => {
    const child = makeFakeChild(++pidCounter)
    const nodeId = (opts.env as Record<string, string>)['DOMINEVO_PARENT_NODE_ID']
    const runnerId = (opts.env as Record<string, string>)['DOMINEVO_RUNNER_ID']
    setImmediate(() => child.stdout.emit('data', Buffer.from(`READY:${nodeId}/${runnerId}\n`)))
    return child as unknown as cp.ChildProcess
  }
  const broker = new ServiceBroker({ nodeID: 'hub-regate', transporter: 'Fake', logger: false })
  const regated: (readonly number[])[] = []

  beforeAll(async () => {
    broker.createService(
      createProcessService('hub-regate', tmpDir, {
        spawnFn: fakeSpawn,
        processGroups: inertProcessGroups,
      }),
    )
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
    __resetStateRefreshPolicyRegistryForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    __resetStateRefreshPolicyRegistryForTests()
    regated.length = 0
    getStateRefreshPolicyRegistry().subscribeRegate((ids) => void regated.push(ids))
  })

  async function spawnWithDevice(runnerId: string, deviceId: number): Promise<void> {
    await broker.call('$process.spawnRunner', {
      runnerId,
      addons: [{ addonId: runnerId, addonDir: `/tmp/${runnerId}` }],
    })
    getStateRefreshPolicyRegistry().replaceSource(childRefreshSource(runnerId), [
      {
        deviceId,
        addonId: runnerId,
        policy: { integrationId: 'int_1', minIntervalMs: 10_000, batch: false, push: 'none' },
      },
    ])
  }

  it('$process.stop', async () => {
    await spawnWithDevice('regate-stop', 41)
    await broker.call('$process.stop', { name: 'regate-stop' })
    expect(regated).toEqual([[41]])
  })

  it('$process.restart', async () => {
    await spawnWithDevice('regate-restart', 42)
    await broker.call('$process.restart', { name: 'regate-restart' })
    expect(regated).toEqual([[42]])
  })

  it('$process.restartAll', async () => {
    await spawnWithDevice('regate-all', 43)
    await broker.call('$process.restartAll', {})
    expect(regated).toContainEqual([43])
  })
})
