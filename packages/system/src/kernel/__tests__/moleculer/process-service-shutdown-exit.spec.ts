/**
 * A runner's exit is graded by WHY it exited, not only by its code.
 *
 * A clean hub shutdown (2026-10-23, fresh dev hub CT200) logged
 * `ERROR [<runner>] Process exited (code=0)` fifteen times: hub-main's SIGTERM
 * handler signals every runner group BEFORE the broker stops, so each runner
 * exited while still `running` and the exit handler read an orderly shutdown
 * as a crash — ERROR, a crash record and a respawn into a dying node.
 *
 *  - an exit during an orderly shutdown is INFO and never respawns;
 *  - an unexpected code-0 exit outside shutdown is WARN (still a crash: respawned);
 *  - a non-zero exit is ERROR.
 */
import type * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ServiceBroker } from 'moleculer'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessService } from '../../moleculer/process-service.js'
import {
  type ProcessGroupOps,
  resetRunnerShutdownForTests,
  signalAllRunnerGroups,
} from '../../moleculer/runner-process-group.js'

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

function exitWith(child: FakeChild, code: number): void {
  child.exitCode = code
  child.emit('exit', code, null)
}

/** An OS whose groups are always already empty: reaps finish at once. */
const emptyGroups: ProcessGroupOps = {
  kill: () => undefined,
  listMembers: () => Promise.resolve([]),
  sleep: () => Promise.resolve(),
  graceMs: 10,
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('process-service: a runner exit is graded by why it exited', { timeout: 20_000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shutdown-exit-'))
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  afterEach(() => {
    resetRunnerShutdownForTests()
  })

  async function harness(nodeId: string) {
    const spawned: FakeChild[] = []
    let pid = 92_000 + Math.floor(Math.random() * 1000) * 10
    const spawnFn = (_c: string, _a: readonly string[], opts: cp.SpawnOptions): cp.ChildProcess => {
      const child = makeFakeChild(++pid)
      spawned.push(child)
      const env = opts.env ?? {}
      setImmediate(() =>
        child.stdout.emit(
          'data',
          Buffer.from(`READY:${env['CAMSTACK_PARENT_NODE_ID']}/${env['CAMSTACK_RUNNER_ID']}\n`),
        ),
      )
      return child as unknown as cp.ChildProcess
    }
    const broker = new ServiceBroker({ nodeID: nodeId, transporter: 'Fake', logger: false })
    broker.createService(
      createProcessService(nodeId, tmpDir, {
        spawnFn,
        processGroups: emptyGroups,
        platform: 'linux',
      }),
    )
    await broker.start()
    const error = vi.spyOn(broker.logger, 'error')
    const warn = vi.spyOn(broker.logger, 'warn')
    const info = vi.spyOn(broker.logger, 'info')
    await broker.call('$process.spawnRunner', {
      runnerId: 'recorder',
      addons: [{ addonId: 'recorder', addonDir: '/tmp/recorder' }],
    })
    await sleep(20) // READY → running
    return { broker, spawned, error, warn, info }
  }

  function exitLines(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Process exited'))
  }

  it('an exit during an orderly shutdown is INFO, and the runner is not respawned', async () => {
    const h = await harness('hub-shutdown-exit')
    // What hub-main's SIGTERM handler does first, before the broker stops.
    signalAllRunnerGroups('SIGTERM')
    exitWith(h.spawned[0]!, 0)
    await sleep(900) // past the first crash backoff (500 ms)
    expect(exitLines(h.error), 'an orderly shutdown logged an ERROR exit').toEqual([])
    expect(exitLines(h.warn)).toEqual([])
    expect(exitLines(h.info)).toHaveLength(1)
    expect(exitLines(h.info)[0]).toContain('code=0')
    expect(h.spawned, 'respawned a runner into a node that is shutting down').toHaveLength(1)
    await h.broker.stop()
  })

  it('an unexpected code-0 exit outside shutdown is WARN (and still respawned)', async () => {
    const h = await harness('hub-unexpected-zero')
    exitWith(h.spawned[0]!, 0)
    await sleep(900)
    expect(exitLines(h.error)).toEqual([])
    expect(exitLines(h.warn)).toHaveLength(1)
    expect(h.spawned.length).toBe(2)
    await h.broker.call('$process.stop', { name: 'recorder' }).catch(() => undefined)
    await h.broker.stop()
  })

  it('a non-zero exit is ERROR', async () => {
    const h = await harness('hub-nonzero-exit')
    exitWith(h.spawned[0]!, 1)
    await sleep(50)
    expect(exitLines(h.error)).toHaveLength(1)
    expect(exitLines(h.error)[0]).toContain('code=1')
    await h.broker.call('$process.stop', { name: 'recorder' }).catch(() => undefined)
    await h.broker.stop()
  })
})
