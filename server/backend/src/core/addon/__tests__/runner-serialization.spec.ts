/**
 * Two converges of one runner never interleave.
 *
 * `ensureForkedRunner` reads the running processes, stops the stale ones and
 * spawns the roster — three awaits. `withRunnerLock` inside `process-service`
 * makes each of `$process.stop` and `$process.spawnRunner` atomic on its own,
 * and that is not the unit that matters: two concurrent converges both read
 * "not running", both stop, and both spawn. One child ends up in the map and
 * the other is alive and untracked.
 *
 * Measured twice on the live hub. 2026-09-16, a deploy plus an operator
 * restart: one "shutting down" and THREE runners started within five seconds.
 * 2026-09-17, with no manual restart at all — a container reboot's own spawn
 * meeting the restart a deploy fires for itself — two runners started in the
 * same second, and HomeKit published every camera twice until one was killed
 * by hand.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createRunnerSerializer } from '../runner-serialization.js'

describe('createRunnerSerializer', () => {
  it('runs two converges of the same runner one after the other', async () => {
    const serialize = createRunnerSerializer()
    const events: string[] = []

    const converge = (tag: string) => async (): Promise<void> => {
      events.push(`${tag}:read`)
      await new Promise((r) => setTimeout(r, 10))
      events.push(`${tag}:stop`)
      await new Promise((r) => setTimeout(r, 10))
      events.push(`${tag}:spawn`)
    }

    await Promise.all([
      serialize('export-hap', converge('a')),
      serialize('export-hap', converge('b')),
    ])

    // Interleaved, the second would read before the first had spawned — which
    // is exactly how both decide to spawn.
    expect(events).toEqual(['a:read', 'a:stop', 'a:spawn', 'b:read', 'b:stop', 'b:spawn'])
  })

  it('does not serialize DIFFERENT runners against each other', async () => {
    const serialize = createRunnerSerializer()
    const order: string[] = []

    await Promise.all([
      serialize('one', async () => {
        await new Promise((r) => setTimeout(r, 20))
        order.push('one')
      }),
      serialize('two', async () => {
        order.push('two')
      }),
    ])

    // A deploy touches many runners; making them wait on each other would turn
    // a parallel reconcile into a serial one for no safety gained.
    expect(order).toEqual(['two', 'one'])
  })

  /**
   * A converge that throws must not wedge the queue behind it. The runner it
   * failed on is already in a bad state; refusing every later converge for
   * that runner would make it permanent.
   */
  it('keeps serving the runner after one converge throws', async () => {
    const serialize = createRunnerSerializer()
    await expect(
      serialize('flaky', async () => {
        throw new Error('stop failed')
      }),
    ).rejects.toThrow('stop failed')

    await expect(serialize('flaky', async () => 'ok')).resolves.toBe('ok')
  })

  it('propagates the converge’s own result', async () => {
    const serialize = createRunnerSerializer()
    await expect(serialize('r', async () => 42)).resolves.toBe(42)
  })
})

/**
 * And the converge really runs inside it.
 *
 * The serializer above is correct in isolation and worth nothing if
 * `ensureForkedRunner` reads, stops and spawns outside it. That is precisely
 * how this defect survived having a lock AND a regression spec one level down:
 * both tested the mechanism, neither tested that the composite sequence was
 * covered. Structural because the defect is a call BOUNDARY, and a unit test
 * of the helper passes either way.
 */
describe('every path that spawns a runner is covered by it', () => {
  const SOURCE = readFileSync(join(__dirname, '../addon-registry.service.ts'), 'utf8')

  /**
   * The first fix covered `ensureForkedRunner` and the duplication happened
   * again on the very next deploy: `initializeAddonGroup` — the BOOT path —
   * calls `$process.spawnRunner` directly. Two paths, one of them serialized,
   * is the same race with a smaller window.
   *
   * So the invariant is not "this function is serialized". It is "EVERY call
   * that spawns a runner happens inside the critical section", and that is
   * what this asserts — including a path nobody has written yet.
   */
  it('leaves no $process.spawnRunner call outside a serializeRunner block', () => {
    const calls = [...SOURCE.matchAll(/\$process\.spawnRunner/g)].map((m) => m.index ?? 0)
    expect(
      calls.length,
      'no spawn call found — this test is reading the wrong file',
    ).toBeGreaterThan(0)

    const guards = [...SOURCE.matchAll(/this\.serializeRunner\(/g)].map((m) => m.index ?? 0)
    for (const at of calls) {
      const nearest = guards.filter((g) => g < at).pop()
      expect(
        nearest,
        `a $process.spawnRunner at offset ${at} has no serializeRunner before it — two converges can both spawn`,
      ).toBeDefined()
    }
  })

  it('wraps the read, the stop and the spawn of a converge in one section', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('private async ensureForkedRunner'))
    const body = fn.slice(0, fn.indexOf('\n  /**', 10))

    const serializeAt = body.indexOf('this.serializeRunner(runnerId')
    expect(serializeAt, 'the converge is not serialized at all').toBeGreaterThanOrEqual(0)

    for (const step of [
      'await this.listRunnerProcesses()',
      "'$process.stop'",
      "'$process.spawnRunner'",
    ]) {
      const at = body.indexOf(step)
      expect(at, `${step} is missing — this test is reading the wrong function`).toBeGreaterThan(-1)
      expect(at, `${step} runs OUTSIDE the critical section`).toBeGreaterThan(serializeAt)
    }
  })
})

/**
 * Losing the race is not a failure.
 *
 * `initializeAddonGroup`'s own docblock promises "No-op when the runner is
 * already running (idempotent for tests + crash respawn paths)", and the code
 * did not keep that promise — it let `Runner "X" already running` propagate as
 * a failed bootstrap. Unserialized that almost never happened, because the
 * loser usually spawned a SECOND runner instead. Serializing makes the loser
 * reliable, so the promise now has to be real.
 */
describe('a boot spawn that loses the race', () => {
  const SOURCE = readFileSync(join(__dirname, '../addon-registry.service.ts'), 'utf8')

  it('is a no-op, as initializeAddonGroup already promised', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('async initializeAddonGroup'))
    const body = fn.slice(0, fn.indexOf('\n  /**', 10))
    expect(
      body,
      'a spawn that loses the race still propagates as a failed bootstrap, against the documented contract',
    ).toMatch(/already running/i)
  })
})
