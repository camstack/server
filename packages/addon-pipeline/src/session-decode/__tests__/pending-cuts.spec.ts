/**
 * The WRITE GAP between a frame's tile cut and the store that answers for it.
 *
 * `handleCutTiles` finds the frame, reads its pixels in one synchronous turn,
 * and only then awaits N JPEG encodes before `tileStore.put`. A native-crop
 * request that lands inside that window consults two empty stores and is told
 * `no retained tile for this frame` — the same sentence a frame that was never
 * cut gets, at an age of a few hundred milliseconds.
 *
 * Measured on the live cluster (2026-09-07): the miss rate is FLAT at 14-38%
 * across cameras whose detection-bearing fraction spans 3.7%-99.7%. dev:102
 * cuts a tile on 99.7% of its inferred frames and still misses 19.5% — so on
 * that camera "no retained tile for this frame" cannot mean "never cut", it
 * means "not written yet".
 *
 * These tests pin the two properties that make waiting safe:
 *  - a request arriving mid-cut is SERVED once the cut lands, instead of
 *    missing;
 *  - a cut that throws, or one that never completes at all, still lets the
 *    waiter give up inside the bound and report the miss. A crop is
 *    best-effort; a waiter that can wedge is not.
 */
import { describe, expect, it } from 'vitest'
import { attemptTileServe, PendingCuts } from '../pending-cuts.js'

/** A serve that answers only once the frame's tiles have been written. */
function makeStore(): {
  put: () => void
  hasRetained: () => boolean
  serve: () => Promise<string | null>
} {
  let written = false
  return {
    put: (): void => {
      written = true
    },
    hasRetained: (): boolean => written,
    serve: (): Promise<string | null> => Promise.resolve(written ? 'pixels' : null),
  }
}

describe('PendingCuts — the in-flight cut window', () => {
  it('reports no wait for a frame whose cut was never begun', async () => {
    const pending = new PendingCuts({ waitMs: 50 })
    await expect(pending.waitFor(7)).resolves.toBe('none')
    expect(pending.inFlight).toBe(0)
  })

  it('resolves a waiter as soon as the cut settles, well inside the bound', async () => {
    const pending = new PendingCuts({ waitMs: 1000 })
    pending.begin(7)
    expect(pending.inFlight).toBe(1)
    const waiting = pending.waitFor(7)
    setTimeout(() => pending.settle(7), 5)
    await expect(waiting).resolves.toBe('settled')
    expect(pending.inFlight).toBe(0)
  })

  it('gives up at the bound when the cut never completes, and stays give-up-able', async () => {
    const pending = new PendingCuts({ waitMs: 20 })
    pending.begin(7)
    await expect(pending.waitFor(7)).resolves.toBe('timeout')
    // The entry is deliberately still in flight — a timeout is the WAITER
    // giving up, never the cut being declared dead.
    expect(pending.inFlight).toBe(1)
    await expect(pending.waitFor(7)).resolves.toBe('timeout')
  })

  it('settles every waiter on clear(), so teardown can never wedge one', async () => {
    const pending = new PendingCuts({ waitMs: 60_000 })
    pending.begin(7)
    const waiting = pending.waitFor(7)
    pending.clear()
    await expect(waiting).resolves.toBe('settled')
    expect(pending.inFlight).toBe(0)
  })

  it('records cut latency and reports p50 / p95 over the samples it has', () => {
    let clock = 0
    const pending = new PendingCuts({ waitMs: 1000, now: () => clock })
    for (const ms of [10, 20, 30, 40, 100]) {
      clock = 0
      pending.begin(ms)
      clock = ms
      pending.settle(ms)
    }
    expect(pending.latencyMs(50)).toBe(30)
    expect(pending.latencyMs(95)).toBe(100)
  })

  it('has no latency to report before the first cut settles', () => {
    const pending = new PendingCuts({ waitMs: 1000 })
    expect(pending.latencyMs(50)).toBeNull()
    pending.begin(1)
    expect(pending.latencyMs(50)).toBeNull()
  })
})

describe('attemptTileServe — waiting only when it can change the answer', () => {
  it('serves immediately, and never waits, when the tiles are already written', async () => {
    const pending = new PendingCuts({ waitMs: 60_000 })
    const store = makeStore()
    store.put()
    pending.begin(7) // a cut IS in flight; it must not be waited on
    const outcome = await attemptTileServe(pending, 7, store)
    expect(outcome.served).toBe('pixels')
    expect(outcome.wait).toBe('none')
    expect(outcome.resolvedByWait).toBe(false)
  })

  it('a request arriving MID-CUT is served once the cut lands, instead of missing', async () => {
    const pending = new PendingCuts({ waitMs: 1000 })
    const store = makeStore()
    pending.begin(7)
    setTimeout(() => {
      store.put()
      pending.settle(7)
    }, 10)
    const outcome = await attemptTileServe(pending, 7, store)
    expect(outcome.served).toBe('pixels')
    expect(outcome.wait).toBe('settled')
    expect(outcome.resolvedByWait).toBe(true)
  })

  it('a cut that THREW still settles, and the serve reports the miss', async () => {
    const pending = new PendingCuts({ waitMs: 1000 })
    const store = makeStore()
    pending.begin(7)
    // The worker settles in a `finally`, so a throwing encode settles too —
    // it simply never wrote a tile.
    setTimeout(() => pending.settle(7), 5)
    const outcome = await attemptTileServe(pending, 7, store)
    expect(outcome.served).toBeNull()
    expect(outcome.wait).toBe('settled')
    expect(outcome.resolvedByWait).toBe(false)
  })

  it('a cut that never completes lets the waiter give up within the bound and miss', async () => {
    const pending = new PendingCuts({ waitMs: 20 })
    const store = makeStore()
    pending.begin(7)
    const startedAt = Date.now()
    const outcome = await attemptTileServe(pending, 7, store)
    expect(outcome.served).toBeNull()
    expect(outcome.wait).toBe('timeout')
    expect(outcome.resolvedByWait).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  it('misses without waiting when nothing is retained and no cut is in flight', async () => {
    const pending = new PendingCuts({ waitMs: 60_000 })
    const store = makeStore()
    const outcome = await attemptTileServe(pending, 7, store)
    expect(outcome.served).toBeNull()
    expect(outcome.wait).toBe('none')
    expect(outcome.resolvedByWait).toBe(false)
  })
})
