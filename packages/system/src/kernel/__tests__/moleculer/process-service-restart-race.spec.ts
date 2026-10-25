/**
 * Regression test for the `camstack deploy` stale-runner LEAK.
 *
 * Root cause: two concurrent lifecycle ops for the SAME runnerId (e.g. two
 * overlapping `camstack deploy`s firing `void restartAddon`, or a deploy
 * overlapping a crash-respawn) interleaved with NO per-runner serialization.
 * Each `$process.restart` captured the OLD child, killed it, `processes.delete`d
 * the map key, then `spawnRunner` re-`set` a fresh child. When two interleaved,
 * the second restart's `delete` evicted the FIRST restart's freshly-spawned
 * child from the map without ever killing it — orphaning a live runner (and its
 * ffmpeg grandchildren). Each pipeline deploy bundles 8 runners, so a single
 * overlapping deploy could leak a whole generation.
 *
 * The invariant under test: after any number of concurrent restarts of one
 * runnerId settle, EXACTLY ONE child is left alive — every displaced child was
 * killed, none orphaned.
 *
 * Mirrors the fake-spawn injection style of process-service-uds-env.spec.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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

const allChildren: FakeChild[] = []

/**
 * How long a killed child takes to actually exit, in ms.
 *
 * `setImmediate` is realistic for the common case and far too fast to land a
 * second caller inside the window this file exists to close — the window is
 * between the restart's `processes.delete` and its own `spawnRunner`, and the
 * restart sits in `await exit` for exactly this long. A real child takes
 * milliseconds; the test needs the same milliseconds to be able to aim at it.
 */
let exitDelayMs = 0

function makeFakeChild(pid: number): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.pid = pid
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.killed = false
  ee.exitCode = null
  ee.signalCode = null
  ee.kill = (sig?: string) => {
    // Killing an already-dead child is a no-op (matches real ChildProcess).
    if (ee.exitCode !== null || ee.signalCode !== null) return false
    ee.killed = true
    // Real children exit asynchronously after a signal — emit on the next
    // tick so the awaiting `on('exit')` listener (attached AFTER .kill())
    // actually catches it instead of missing a synchronous emit.
    const fire = (): void => {
      ee.signalCode = sig ?? 'SIGTERM'
      ee.emit('exit', null, ee.signalCode)
    }
    if (exitDelayMs > 0) setTimeout(fire, exitDelayMs)
    else setImmediate(fire)
    return true
  }
  return ee
}

describe('process-service: concurrent restarts of one runnerId never orphan a child', {
  timeout: 15000,
}, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-restart-race-'))
  let pidCounter = 70000

  const fakeSpawn = (
    _command: string,
    _args: readonly string[],
    opts: cp.SpawnOptions,
  ): cp.ChildProcess => {
    const child = makeFakeChild(++pidCounter)
    // The child signals READY on stdout so the runner reaches `running`.
    const nodeId = (opts.env as Record<string, string>)['CAMSTACK_PARENT_NODE_ID']
    const runnerId = (opts.env as Record<string, string>)['CAMSTACK_RUNNER_ID']
    allChildren.push(child)
    setImmediate(() => child.stdout.emit('data', Buffer.from(`READY:${nodeId}/${runnerId}\n`)))
    return child as unknown as cp.ChildProcess
  }

  const broker = new ServiceBroker({ nodeID: 'hub-race', transporter: 'Fake', logger: false })

  beforeAll(async () => {
    broker.createService(
      createProcessService('hub-race', tmpDir, {
        spawnFn: fakeSpawn,
        processGroups: inertProcessGroups,
      }),
    )
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  it('leaves exactly one live child after two concurrent restarts', async () => {
    const addons = [{ addonId: 'racey', addonDir: '/tmp/racey' }]
    await broker.call('$process.spawnRunner', { runnerId: 'racey', addons })
    expect(allChildren.length).toBe(1) // boot child

    // Fire two restarts WITHOUT awaiting between them — they interleave.
    const p1 = broker.call('$process.restart', { name: 'racey' })
    const p2 = broker.call('$process.restart', { name: 'racey' })
    await Promise.all([p1, p2])

    // Every child except exactly one must have been killed. Without per-runner
    // serialization the middle child (spawned by the first restart, evicted by
    // the second restart's delete) is never killed → two live children.
    const alive = allChildren.filter((c) => !c.killed)
    expect(alive.length).toBe(1)
  })

  /**
   * The SAME leak through the one action that never took the lock.
   *
   * `restart`, `stop` and `restartAll` all run inside `withRunnerLock`.
   * `spawnRunner` did not: it guarded with `if (processes.has(runnerId)) throw`,
   * which is a check-then-act, and the check is only true between a restart's
   * `processes.delete` and its own `spawnRunner`. Land there and BOTH spawn:
   * the action's child is registered, the restart's child overwrites the map
   * entry, and the action's child is alive and untracked.
   *
   * Measured twice on the live hub. 2026-09-16, deploy + an operator restart:
   * one "shutting down" and THREE runners started within five seconds.
   * 2026-09-17, with no manual restart at all — a container reboot's boot spawn
   * racing the deploy's own restart — two runners started in the same second,
   * and HomeKit published every camera twice.
   */
  it('leaves exactly one live child when a spawn races a restart', async () => {
    const addons = [{ addonId: 'boot-racer', addonDir: '/tmp/boot-racer' }]
    await broker.call('$process.spawnRunner', { runnerId: 'boot-racer', addons })
    const before = allChildren.length

    // A restart in flight, and a spawn arriving while it is between its
    // `processes.delete` and its own spawn — the real sequence: a boot-time
    // spawn meeting the restart a deploy fires for itself.
    // Hold the restart inside its `await exit` long enough for the spawn to
    // arrive there. Without this the restart finishes first and the spawn is
    // refused by the guard — green, and proving nothing.
    exitDelayMs = 50
    const restarting = broker.call('$process.restart', { name: 'boot-racer' })
    await new Promise((r) => setTimeout(r, 20))
    const spawning = broker
      .call('$process.spawnRunner', { runnerId: 'boot-racer', addons })
      // Under the lock this loses the race and is REFUSED, which is the
      // correct outcome: the runner exists, so spawning a second is the bug.
      .catch(() => undefined)
    await Promise.all([restarting, spawning])
    exitDelayMs = 0

    const mine = allChildren.slice(before - 1)
    const alive = mine.filter((c) => !c.killed)
    expect(
      alive.length,
      'a child was spawned and left untracked — the orphan that publishes every camera twice',
    ).toBe(1)
  })
})
