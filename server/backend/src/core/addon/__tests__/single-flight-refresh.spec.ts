/**
 * The gate in front of the device-parent mirror rebuild.
 *
 * Every assertion here is one of the two things that make it safe to put a
 * gate in front of authorisation-backing state:
 *
 *  - it never SKIPS the last event (a burst always ends in a complete
 *    rebuild), which is what keeps the mirror convergent;
 *  - it never DELAYS the first one (no timer), which is what keeps a fresh
 *    grant from being denied for a debounce window.
 *
 * Remove the gate and the first test fails with 1 000 runs where 2 are
 * correct; remove the follow-up and the second fails with a mirror frozen at
 * the state before the last event.
 */

import { describe, expect, it } from 'vitest'
import type { RefreshScope } from '../single-flight-refresh.js'
import { createSingleFlightRefresh } from '../single-flight-refresh.js'

/** A run whose completion the test controls. */
function gatedRun(): {
  readonly run: (scope: RefreshScope) => Promise<void>
  readonly calls: () => number
  readonly scopes: () => readonly RefreshScope[]
  readonly finishOne: () => void
} {
  let calls = 0
  const seen: RefreshScope[] = []
  const waiting: Array<() => void> = []
  return {
    run: async (scope: RefreshScope): Promise<void> => {
      calls += 1
      seen.push(scope)
      await new Promise<void>((resolve) => waiting.push(resolve))
    },
    calls: () => calls,
    scopes: () => seen,
    finishOne: () => {
      const next = waiting.shift()
      if (next === undefined) throw new Error('no run is waiting')
      next()
    },
  }
}

describe('createSingleFlightRefresh', () => {
  it('runs the first request immediately — no timer, no window', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const first = gate.request(null)
    expect(g.calls(), 'the first request must not wait for a debounce').toBe(1)

    g.finishOne()
    await first
  })

  it('collapses a burst arriving during a run into ONE follow-up', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const first = gate.request(null)
    const burst = [gate.request(null), gate.request(null), gate.request(null), gate.request(null)]
    expect(g.calls(), 'the burst must not start runs of its own').toBe(1)

    g.finishOne() // first run completes → exactly one follow-up starts
    await first
    expect(g.calls()).toBe(2)

    g.finishOne() // follow-up completes
    await Promise.all(burst)
    expect(g.calls(), 'four requests during one run are one follow-up').toBe(2)
  })

  it('always ends a burst with a run that started after the last request', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)
    const order: string[] = []

    const first = gate.request(null)
    const late = gate.request(null).then(() => order.push('late-satisfied'))
    order.push('last-event')

    g.finishOne()
    await first
    // The follow-up STARTED after 'last-event' was recorded — that is the
    // convergence property: whatever the last event changed is inside it.
    expect(g.calls()).toBe(2)
    expect(order).toEqual(['last-event'])

    g.finishOne()
    await late
    expect(order).toEqual(['last-event', 'late-satisfied'])
  })

  it('starts a fresh run once the gate is idle again', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const a = gate.request(null)
    g.finishOne()
    await a
    expect(g.calls()).toBe(1)

    const b = gate.request(null)
    expect(g.calls(), 'an idle gate must not swallow the next event').toBe(2)
    g.finishOne()
    await b
  })

  it('does not wedge when a run rejects, and still honours the follow-up', async () => {
    let calls = 0
    const gate = createSingleFlightRefresh(async (_scope: RefreshScope) => {
      calls += 1
      await Promise.resolve()
      if (calls === 1) throw new Error('listAll timed out')
    })

    const first = gate.request(null)
    const during = gate.request(null)
    await expect(first).rejects.toThrow('listAll timed out')
    await during

    expect(calls, 'a failed run must still release the slot and run the follow-up').toBe(2)

    // And the gate is usable afterwards.
    await gate.request(null)
    expect(calls).toBe(3)
  })
})

describe('createSingleFlightRefresh — the collapsed scope is the UNION, never a narrowing', () => {
  it('two scoped requests during one run become ONE run over both ids', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const first = gate.request(new Set([1]))
    // Two DISJOINT scopes: a gate that merely remembers the last one would
    // lose device 2 entirely, and the mirror would keep serving its old parent.
    const a = gate.request(new Set([2]))
    const b = gate.request(new Set([3]))
    expect(g.calls()).toBe(1)

    g.finishOne()
    await first
    expect(g.calls()).toBe(2)
    const second = g.scopes()[1]
    expect(second).not.toBeNull()
    expect(
      [...(second ?? [])].sort((x, y) => x - y),
      'collapsing must never drop an id',
    ).toEqual([2, 3])

    g.finishOne()
    await Promise.all([a, b])
  })

  it('a fleet request absorbs the ids queued beside it — widening is always safe', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const first = gate.request(new Set([1]))
    const everything = gate.request(null)
    // Queued AFTER the fleet request: last-wins would narrow the follow-up
    // back to one device and the rest of the fleet would never be re-read.
    const scoped = gate.request(new Set([2]))

    g.finishOne()
    await first
    expect(g.scopes()[1], 'a fleet request cannot be narrowed back to an id set').toBeNull()

    g.finishOne()
    await Promise.all([scoped, everything])
  })

  it('an id queued BEFORE a fleet request is absorbed by it', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const first = gate.request(new Set([1]))
    const scoped = gate.request(new Set([2]))
    const everything = gate.request(null)

    g.finishOne()
    await first
    expect(g.scopes()[1]).toBeNull()

    g.finishOne()
    await Promise.all([scoped, everything])
  })

  it('an EMPTY set runs nothing at all — a request for no devices is a request', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    await gate.request(new Set())

    expect(g.calls(), 'an empty scope must never degrade to a full-fleet read').toBe(0)
  })

  it('an empty set queued during a run does not start a follow-up on its own', async () => {
    const g = gatedRun()
    const gate = createSingleFlightRefresh(g.run)

    const first = gate.request(new Set([1]))
    await gate.request(new Set())
    g.finishOne()
    await first

    expect(g.calls()).toBe(1)
  })
})
