/**
 * A runner the D6 crash circuit-breaker gives up on must be LOUD.
 *
 * ── The outage this pins (2026-08-18, 11:46 → 15:00) ──────────────────────
 * The `recorder` runner crashed five times in nine seconds, the breaker
 * tripped exactly as designed, and then… nothing. `/health` stayed 200, the
 * hub answered `Capability "recording" provider not available` for three hours
 * and fifteen minutes, and the only signal that ever reached the operator was
 * his phone failing to load recordings that evening.
 *
 * The breaker is CORRECT (D6) and is not weakened here: it still bounds
 * respawns and still marks the runner terminally `failed`. What it now also
 * does is SAY SO on the event bus, on a category the Notification Center's
 * system-event intake consumes — so an operator's existing rule carries it.
 *
 * `AddonCrashed` already fires here, and is deliberately NOT reused: it is the
 * addon-lifecycle channel the admin UI refreshes on, it carries no node and no
 * crash count, and "an addon crashed" is a routine, self-healing fact. "This
 * runner will never come back on its own" is a different sentence.
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
import { createProcessService } from '../../moleculer/process-service.js'
import { inertProcessGroups } from './inert-process-groups.js'

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
  killed: boolean
  exitCode: number | null
  signalCode: string | null
}

const spawned: FakeChild[] = []

function makeFakeChild(pid: number): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.pid = pid
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.killed = false
  ee.exitCode = null
  ee.signalCode = null
  ee.kill = () => true
  return ee
}

/** Crash the newest runner child the way an uncaught exception does. */
function crashNewestChild(): void {
  const child = spawned[spawned.length - 1]
  if (child === undefined) throw new Error('no child spawned')
  child.exitCode = 1
  child.emit('exit', 1, null)
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** Wait until the backoff respawn has produced its child. */
async function waitForSpawn(count: number): Promise<void> {
  const deadline = Date.now() + 20_000
  while (spawned.length < count) {
    if (Date.now() > deadline) throw new Error(`no respawn: ${spawned.length} < ${count}`)
    await settle()
  }
  await settle()
}

describe('process-service: the crash circuit-breaker announces the runner it gave up on', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-breaker-event-'))
  let pidCounter = 80_000

  const fakeSpawn = (
    _command: string,
    _args: readonly string[],
    opts: cp.SpawnOptions,
  ): cp.ChildProcess => {
    const child = makeFakeChild(++pidCounter)
    const env = opts.env ?? {}
    const nodeId = env['CAMSTACK_PARENT_NODE_ID']
    const runnerId = env['CAMSTACK_RUNNER_ID']
    spawned.push(child)
    setImmediate(() => child.stdout.emit('data', Buffer.from(`READY:${nodeId}/${runnerId}\n`)))
    return child as unknown as cp.ChildProcess
  }

  const broker = new ServiceBroker({ nodeID: 'hub-breaker', transporter: 'Fake', logger: false })
  const seen: SystemEvent[] = []

  beforeAll(async () => {
    broker.createService(
      createProcessService('hub-breaker', tmpDir, {
        spawnFn: fakeSpawn,
        processGroups: inertProcessGroups,
      }),
    )
    await broker.start()
    getBrokerEventBus(broker).subscribe({ category: EventCategory.AddonRunnerFailed }, (event) => {
      seen.push(event)
    })
  })

  afterAll(async () => {
    await broker.stop()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  it('emits addon.runner-failed exactly once, naming the node, the addons and the count', async () => {
    const addons = [{ addonId: 'recorder', addonDir: '/tmp/recorder' }]
    await broker.call('$process.spawnRunner', { runnerId: 'recorder', addons })
    await settle()

    // MAX_CRASHES_IN_WINDOW is 5. The first four respawn (with backoff); the
    // fifth trips the breaker. Each respawn is scheduled on a timer, so drive
    // the crash from whatever child is currently alive.
    for (let i = 0; i < 4; i++) {
      const before = spawned.length
      crashNewestChild()
      // Backoff is 500 · 2^(n-1) — wait for the respawn rather than guessing.
      await waitForSpawn(before + 1)
    }
    expect(seen).toHaveLength(0) // still respawning — nothing terminal to announce
    crashNewestChild()
    await settle()

    expect(seen).toHaveLength(1)
    const payload = seen[0]!.data
    expect(payload).toMatchObject({
      runnerId: 'recorder',
      nodeId: 'hub-breaker',
      addonIds: ['recorder'],
      crashesInWindow: 5,
    })
    // The window is part of the sentence: "5 crashes" means nothing without it.
    expect(payload['windowMs']).toBe(60_000)
  }, 40_000)
})
