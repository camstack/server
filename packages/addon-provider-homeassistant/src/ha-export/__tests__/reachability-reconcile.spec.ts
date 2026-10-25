import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_INTERVAL_MS, PushClient } from '../push-client.js'
import {
  REACHABILITY_RECONCILE_MIN_INTERVAL_MS,
  ReachabilityReconciler,
} from '../reachability-reconcile.js'
import type { PushMessage } from '../types.js'

const noopLog = { warn: () => {}, info: () => {}, debug: () => {} }

describe('ReachabilityReconciler', () => {
  let runs: (readonly string[])[]
  let reconciler: ReachabilityReconciler

  beforeEach(() => {
    vi.useFakeTimers()
    runs = []
    reconciler = new ReachabilityReconciler({
      run: ({ brokerIds }) => runs.push(brokerIds),
    })
  })

  afterEach(() => {
    reconciler.dispose()
    vi.useRealTimers()
  })

  it('repairs the first returning link at once, not on the periodic pass', async () => {
    reconciler.request('ha_1')
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toEqual([['ha_1']])
  })

  it('coalesces every link that returns in one window into ONE re-announce', async () => {
    reconciler.request('ha_1')
    reconciler.request('ha_2')
    reconciler.request('ha_1')
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toEqual([['ha_1', 'ha_2']])
  })

  /**
   * The storm bound. A link flapping every second must not be able to
   * re-announce ~880 entities every second.
   */
  it('bounds a flapping link to one re-announce per window', async () => {
    for (let elapsed = 0; elapsed < REACHABILITY_RECONCILE_MIN_INTERVAL_MS * 2; elapsed += 1_000) {
      reconciler.request('ha_1')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(runs.length).toBeLessThanOrEqual(3)
    expect(runs.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * Bounded is not the same as dropped. A request inside the window is
   * DEFERRED to its edge — the cache has already been cleared by then, so
   * dropping it would leave Home Assistant blank until the periodic pass,
   * which is the defect this class exists to fix.
   */
  it('never drops a request made inside the window — it defers it to the edge', async () => {
    reconciler.request('ha_1')
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toHaveLength(1)

    reconciler.request('ha_2')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(REACHABILITY_RECONCILE_MIN_INTERVAL_MS)
    expect(runs).toEqual([['ha_1'], ['ha_2']])
  })

  it('reports what it scheduled and how long the bound made it wait', async () => {
    const scheduled: { brokerId: string; delayMs: number }[] = []
    const spy = new ReachabilityReconciler({
      run: () => {},
      onScheduled: (info) => scheduled.push({ brokerId: info.brokerId, delayMs: info.delayMs }),
    })
    try {
      spy.request('ha_1')
      await vi.advanceTimersByTimeAsync(1)
      spy.request('ha_1')
      await vi.advanceTimersByTimeAsync(1)
      expect(scheduled).toHaveLength(2)
      expect(scheduled[0]?.delayMs).toBe(0)
      expect(scheduled[1]?.delayMs).toBeGreaterThan(0)
    } finally {
      spy.dispose()
    }
  })

  it('runs nothing after dispose', async () => {
    reconciler.request('ha_1')
    reconciler.dispose()
    await vi.advanceTimersByTimeAsync(REACHABILITY_RECONCILE_MIN_INTERVAL_MS * 2)
    expect(runs).toEqual([])
  })
})

/**
 * The composition, exercised through the real sender: a failed POST
 * followed by a successful one is the ONLY thing the addon wires, so it
 * is the thing worth testing end to end.
 */
describe('PushClient + ReachabilityReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turns an unreachable→reachable edge into exactly one bounded re-announce', async () => {
    const runs: (readonly string[])[] = []
    const reconciler = new ReachabilityReconciler({ run: ({ brokerIds }) => runs.push(brokerIds) })
    const state = { fail: false }
    const client = new PushClient({
      transport: async (_message: PushMessage): Promise<void> => {
        if (state.fail) throw new Error('unreachable')
      },
      logger: noopLog,
      brokerId: 'ha_1',
      onLinkRestored: (brokerId) => reconciler.request(brokerId),
    })
    try {
      client.start()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
      expect(runs).toEqual([])

      state.fail = true
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
      state.fail = false
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)

      expect(runs).toEqual([['ha_1']])
    } finally {
      await client.dispose()
      reconciler.dispose()
    }
  })
})
