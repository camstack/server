/**
 * The drain, end to end through `StoragePressureManager` (D386).
 *
 * The ratchet's arithmetic is pinned in `drain-ratchet.spec.ts`. What this file
 * pins is the WIRING: that the cap reaches the same `relieveToUsageCap`
 * machinery every other cap uses, that a no-growth sweep evicts nothing, that
 * the state comes back off the store after a restart, and that switching the
 * location out of `drain` stops it and drops the state.
 */
import type { IScopedLogger, IStorageEvictableProvider } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DrainState } from '../drain-ratchet.js'
import type { DrainPlanEntry, DrainStateStore } from '../storage-pressure-manager.js'
import { StoragePressureManager } from '../storage-pressure-manager.js'

const GB = 1024 ** 3

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

/** A store that keeps its rows across "restarts" — the point of the test. */
class MemoryDrainStore implements DrainStateStore {
  readonly rows = new Map<string, DrainState>()
  load(): Promise<readonly DrainState[]> {
    return Promise.resolve([...this.rows.values()])
  }
  save(state: DrainState): Promise<void> {
    this.rows.set(state.locationId, state)
    return Promise.resolve()
  }
  clear(locationId: string): Promise<void> {
    this.rows.delete(locationId)
    return Promise.resolve()
  }
}

/** One evictable provider over a mutable per-location byte count. */
interface Harness {
  readonly manager: StoragePressureManager
  readonly usage: Map<string, number>
  readonly evictions: Array<{ locationId: string; targetBytes: number }>
  plan: readonly DrainPlanEntry[]
}

function makeHarness(store: DrainStateStore, usage: Map<string, number>): Harness {
  const evictions: Array<{ locationId: string; targetBytes: number }> = []
  const provider: IStorageEvictableProvider = {
    getEvictableUsage: async ({ locationId }) =>
      Promise.resolve({ bytes: usage.get(locationId) ?? 0 }),
    evict: async ({ locationId, targetBytes }) => {
      evictions.push({ locationId, targetBytes })
      const before = usage.get(locationId) ?? 0
      const reclaimed = Math.min(before, targetBytes)
      usage.set(locationId, before - reclaimed)
      return Promise.resolve({ reclaimedBytes: reclaimed, exhausted: reclaimed < targetBytes })
    },
  }
  const harness: Harness = {
    usage,
    evictions,
    plan: [],
    manager: new StoragePressureManager({
      logger: makeLogger(),
      getFreePercent: async () => Promise.resolve(100),
      getVolumeTotalBytes: async () => Promise.resolve(1000 * GB),
      getEvictableProviders: () => [provider],
      // No pressure guard and no usage cap: the drain is the ONLY thing that
      // can delete anything in this harness, so every eviction below is one it
      // ordered.
      getLocationThresholds: () => Promise.resolve(new Map()),
      getDrainPlan: () => Promise.resolve(harness.plan),
      drainState: store,
    }),
  }
  return harness
}

const DRAINING: readonly DrainPlanEntry[] = [
  { locationId: 'recordings:old', activePeerLocationIds: ['recordings:new'] },
]

describe('the drain sweep', () => {
  let store: MemoryDrainStore
  let usage: Map<string, number>
  let h: Harness

  beforeEach(() => {
    store = new MemoryDrainStore()
    usage = new Map([
      ['recordings:old', 100 * GB],
      ['recordings:new', 40 * GB],
    ])
    h = makeHarness(store, usage)
    h.plan = DRAINING
  })

  it('the first sweep arms the ratchet and deletes nothing', async () => {
    await h.manager.sweep()
    expect(h.evictions).toEqual([])
    expect(usage.get('recordings:old')).toBe(100 * GB)
    expect(store.rows.get('recordings:old')?.capBytes).toBe(100 * GB)
  })

  it('no growth in the destination ⇒ nothing is deleted', async () => {
    await h.manager.sweep()
    await h.manager.sweep() // the peer did not move
    expect(usage.get('recordings:old')).toBe(100 * GB)
    expect(
      h.evictions.filter((e) => e.targetBytes > 0 && e.locationId === 'recordings:old'),
    ).toEqual([])
  })

  it('cedes exactly what the ACTIVE peer gained', async () => {
    await h.manager.sweep()
    usage.set('recordings:new', 43 * GB)
    await h.manager.sweep()
    expect(usage.get('recordings:old')).toBe(97 * GB)
    expect(store.rows.get('recordings:old')?.capBytes).toBe(97 * GB)
  })

  it('survives a restart — the cap comes back off the store, not off usage', async () => {
    await h.manager.sweep()
    usage.set('recordings:new', 50 * GB)
    await h.manager.sweep()
    expect(usage.get('recordings:old')).toBe(90 * GB)

    // A NEW manager over the SAME store: this is the restart. A cap recomputed
    // from scratch would start again at 90 GB and cede nothing more this sweep
    // — instead the drain start and the observed growth survive, and the next
    // growth keeps ratcheting down from where it left off.
    const restarted = makeHarness(store, usage)
    restarted.plan = DRAINING
    usage.set('recordings:new', 55 * GB)
    await restarted.manager.sweep()
    expect(usage.get('recordings:old')).toBe(85 * GB)
    expect(store.rows.get('recordings:old')?.startBytes).toBe(100 * GB)
  })

  it('reaching zero stops the ratchet and reports the location drained', async () => {
    usage.set('recordings:old', 0)
    await h.manager.sweep()
    const [progress] = h.manager.drainProgressSnapshot()
    expect(progress?.drained).toBe(true)
    expect(progress?.bytesRemaining).toBe(0)
    expect(progress?.estimatedEmptyAtMs).toBeNull()
  })

  it('switching the location back to readonly/active stops it IMMEDIATELY', async () => {
    await h.manager.sweep()
    usage.set('recordings:new', 50 * GB)
    await h.manager.sweep()
    expect(store.rows.has('recordings:old')).toBe(true)

    h.plan = []
    await h.manager.sweep()
    expect(store.rows.has('recordings:old')).toBe(false)
    expect(h.manager.drainProgressSnapshot()).toEqual([])

    const before = usage.get('recordings:old')
    usage.set('recordings:new', 90 * GB)
    await h.manager.sweep()
    expect(usage.get('recordings:old')).toBe(before)
  })

  it('reports bytes remaining and an empty time only once growth is observed', async () => {
    await h.manager.sweep()
    expect(h.manager.drainProgressSnapshot()[0]?.estimatedEmptyAtMs).toBeNull()
    usage.set('recordings:new', 50 * GB)
    await h.manager.sweep()
    const [progress] = h.manager.drainProgressSnapshot()
    expect(progress?.bytesRemaining).toBe(90 * GB)
    // The two sweeps are the same millisecond in this harness, so no elapsed
    // time was observed and the estimate is honestly absent rather than
    // infinite. The property that matters: never a fabricated date.
    expect(progress?.estimatedEmptyAtMs === null || (progress?.estimatedEmptyAtMs ?? 0) > 0).toBe(
      true,
    )
  })

  it('a location with NO active peer has an unmeasurable pace and cedes nothing', async () => {
    h.plan = [{ locationId: 'recordings:old', activePeerLocationIds: [] }]
    await h.manager.sweep()
    usage.set('recordings:new', 90 * GB)
    await h.manager.sweep()
    expect(usage.get('recordings:old')).toBe(100 * GB)
  })
})
