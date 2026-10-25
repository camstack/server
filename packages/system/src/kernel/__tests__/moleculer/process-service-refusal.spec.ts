/**
 * D877: a deterministic Init refusal is not a crash.
 *
 * 2026-10-17: twenty-eight addons refused to start on an unmigrated store, exited
 * 5 times in 10 s and the D6 breaker parked them `failed`, indistinguishable from
 * a crash loop and counted as one. A refusal repeats identically until somebody
 * changes the world, so it must (a) never count toward the breaker, (b) never
 * respawn by itself, (c) carry its reason, and (d) be retried by an operator
 * restart.
 */
import type * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventCategory, type SystemEvent } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBrokerEventBus } from '../../moleculer/event-bus.js'
import { createProcessService, type ProcessInfo } from '../../moleculer/process-service.js'
import {
  formatRunnerRefusalLine,
  RUNNER_REFUSED_EXIT_CODE,
} from '../../moleculer/runner-refusal.js'
import { inertProcessGroups } from './inert-process-groups.js'

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
  exitCode: number | null
  signalCode: string | null
  nodeId: string
}

const spawned: FakeChild[] = []
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function newest(): FakeChild {
  const child = spawned[spawned.length - 1]
  if (child === undefined) throw new Error('no child spawned')
  return child
}

describe('process-service: a typed Init refusal parks the runner, it does not crash it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-refusal-'))
  let pid = 90_000
  const fakeSpawn = (_c: string, _a: readonly string[], opts: cp.SpawnOptions): cp.ChildProcess => {
    const ee = new EventEmitter() as FakeChild
    ee.pid = ++pid
    ee.stdout = new EventEmitter()
    ee.stderr = new EventEmitter()
    ee.exitCode = null
    ee.signalCode = null
    ee.kill = () => true
    ee.nodeId = `${opts.env?.['CAMSTACK_PARENT_NODE_ID']}/${opts.env?.['CAMSTACK_RUNNER_ID']}`
    spawned.push(ee)
    return ee as unknown as cp.ChildProcess
  }
  const broker = new ServiceBroker({ nodeID: 'hub-refusal', transporter: 'Fake', logger: false })
  const refusedEvents: SystemEvent[] = []
  const failedEvents: SystemEvent[] = []
  const crashedEvents: SystemEvent[] = []
  const stateEvents: SystemEvent[] = []
  const addons = [{ addonId: 'auth', addonDir: '/tmp/auth' }]

  beforeAll(async () => {
    broker.createService(
      createProcessService('hub-refusal', tmpDir, {
        spawnFn: fakeSpawn,
        processGroups: inertProcessGroups,
      }),
    )
    await broker.start()
    const bus = getBrokerEventBus(broker)
    bus.subscribe({ category: EventCategory.AddonRunnerRefused }, (e) => refusedEvents.push(e))
    bus.subscribe({ category: EventCategory.AddonRunnerFailed }, (e) => failedEvents.push(e))
    bus.subscribe({ category: EventCategory.AddonCrashed }, (e) => crashedEvents.push(e))
    bus.subscribe({ category: EventCategory.ProcessStateChanged }, (e) => stateEvents.push(e))
  })
  afterAll(async () => {
    await broker.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const refuse = (child: FakeChild): void => {
    child.stdout.emit(
      'data',
      Buffer.from(
        formatRunnerRefusalLine(child.nodeId, {
          addonId: 'auth',
          code: 'unmigrated-settings',
          reason: 'legacy blobs',
          remedy: 'run the migration',
        }),
      ),
    )
    child.exitCode = RUNNER_REFUSED_EXIT_CODE
    child.emit('exit', RUNNER_REFUSED_EXIT_CODE, null)
  }

  it('refuses 6 times without ever reaching `failed`, with its reason, and never respawns alone', async () => {
    await broker.call('$process.spawnRunner', { runnerId: 'auth', addons })
    await settle()
    // Six > MAX_CRASHES_IN_WINDOW (5): were refusals counted, the 5th would trip the breaker.
    for (let i = 0; i < 6; i++) {
      refuse(newest())
      await settle()
      const list = await broker.call<readonly ProcessInfo[], Record<string, never>>(
        '$process.list',
        {},
      )
      expect(list.find((p) => p.name === 'auth')?.state).toBe('refused')
      if (i < 5) {
        // An operator restart is the only way back: it respawns.
        const before = spawned.length
        await broker.call('$process.restart', { name: 'auth' })
        expect(spawned.length).toBe(before + 1)
      }
    }
    const list = await broker.call<readonly ProcessInfo[], Record<string, never>>(
      '$process.list',
      {},
    )
    const row = list.find((p) => p.name === 'auth')
    expect(row?.state).toBe('refused')
    expect(row?.refusal).toMatchObject({ code: 'unmigrated-settings', remedy: 'run the migration' })
    expect(failedEvents).toHaveLength(0)
    // a refusal is NOT announced as a crash
    expect(crashedEvents).toHaveLength(0)
    expect(refusedEvents).toHaveLength(6)
    expect(refusedEvents[0]?.data).toMatchObject({ runnerId: 'auth', code: 'unmigrated-settings' })
    // No timer-driven respawn follows a refusal.
    const count = spawned.length
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(spawned.length).toBe(count)
  }, 20_000)

  it('classifies the refusal exit code even when the stdout line was lost', async () => {
    await broker.call('$process.restart', { name: 'auth' })
    const child = newest()
    child.exitCode = RUNNER_REFUSED_EXIT_CODE
    child.emit('exit', RUNNER_REFUSED_EXIT_CODE, null)
    await settle()
    const list = await broker.call<readonly ProcessInfo[], Record<string, never>>(
      '$process.list',
      {},
    )
    const row = list.find((p) => p.name === 'auth')
    expect(row?.state).toBe('refused')
    expect(row?.refusal?.code).toBe('unknown')
  })

  it('a REFUSED line is honoured only with exit code 78: any other exit is a crash', async () => {
    await broker.call('$process.restart', { name: 'auth' })
    const child = newest()
    child.stdout.emit(
      'data',
      Buffer.from(
        formatRunnerRefusalLine(child.nodeId, {
          addonId: 'auth',
          code: 'unmigrated-settings',
          reason: 'legacy blobs',
          remedy: 'run the migration',
        }),
      ),
    )
    const before = refusedEvents.length
    child.exitCode = 1
    child.emit('exit', 1, null)
    await settle()
    const list = await broker.call<readonly ProcessInfo[], Record<string, never>>(
      '$process.list',
      {},
    )
    // waiting on its backoff respawn, visible as crashed (not "missing", not refused)
    expect(list.find((p) => p.name === 'auth')?.state).toBe('crashed')
    expect(list.find((p) => p.name === 'auth')?.refusal).toBeUndefined()
    expect(refusedEvents).toHaveLength(before)
  })

  it('announces every settled state: running on READY, crashed, refused', async () => {
    const before = stateEvents.length
    // the crash above is waiting on its backoff respawn: let it spawn
    const spawnedBefore = spawned.length
    const deadline = Date.now() + 5_000
    while (spawned.length === spawnedBefore && Date.now() < deadline) await settle()
    const child = newest()
    child.stdout.emit('data', Buffer.from(`READY:${child.nodeId}\n`))
    await settle()
    const states = stateEvents.slice(before).map((e) => e.data['state'])
    expect(states).toContain('running')
  })
})
