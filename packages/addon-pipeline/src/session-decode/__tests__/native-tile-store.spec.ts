import { describe, expect, it } from 'vitest'
import type { ResolvedRegion } from '../crop-geometry.js'
import { type NativeTile, NativeTileStore } from '../native-tile-store.js'

const region = (left: number, top: number, width: number, height: number): ResolvedRegion => ({
  left,
  top,
  width,
  height,
})

const tile = (bytes: number, at: ResolvedRegion = region(0, 0, 100, 100)): NativeTile => ({
  region: at,
  bytes: new Uint8Array(bytes),
})

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('NativeTileStore', () => {
  it('retains a frame’s tiles and serves them back', () => {
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000 })
    const tiles = [tile(100), tile(200)]
    expect(store.put(1, tiles)).toBe(true)
    expect(store.get(1)).toBe(tiles)
    expect(store.frameCount).toBe(1)
    expect(store.tileCount).toBe(2)
    expect(store.totalBytes).toBe(300)
  })

  it('an unknown frame is an empty result, never a throw', () => {
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000 })
    expect(store.get(7)).toEqual([])
  })

  // A tile IS speculative — nothing is waiting on it — so a clock is the honest
  // bound here, and the inverse of the held frame's event-driven lifetime.
  it('expires on the TTL and frees the bytes', () => {
    const clock = fakeClock()
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000, now: clock.now })
    store.put(1, [tile(500)])
    clock.advance(29_999)
    expect(store.get(1)).toHaveLength(1)
    clock.advance(2)
    expect(store.get(1)).toEqual([])
    expect(store.totalBytes).toBe(0)
  })

  it('survives an ask far beyond the old lease TTL — the whole point', () => {
    const clock = fakeClock()
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000, now: clock.now })
    store.put(1, [tile(500)])
    // The MEASURED ask age on this cluster: 2.2-9.9 s. The old 1 200 ms lease
    // could not be there; a tile is.
    clock.advance(9_900)
    expect(store.get(1)).toHaveLength(1)
  })

  it('evicts the OLDEST frame past the RAM budget', () => {
    const store = new NativeTileStore({ budgetBytes: 250, ttlMs: 30_000 })
    store.put(1, [tile(100)])
    store.put(2, [tile(100)])
    store.put(3, [tile(100)])
    expect(store.get(1)).toEqual([])
    expect(store.get(2)).toHaveLength(1)
    expect(store.get(3)).toHaveLength(1)
    expect(store.totalBytes).toBe(200)
  })

  it('never evicts the entry it just admitted', () => {
    const store = new NativeTileStore({ budgetBytes: 50, ttlMs: 30_000 })
    store.put(1, [tile(1000)])
    expect(store.get(1)).toHaveLength(1)
  })

  it('budget 0 disables the store: put declines and nothing is retained', () => {
    const store = new NativeTileStore({ budgetBytes: 0, ttlMs: 30_000 })
    expect(store.enabled).toBe(false)
    expect(store.put(1, [tile(100)])).toBe(false)
    expect(store.get(1)).toEqual([])
    expect(store.totalBytes).toBe(0)
  })

  it('an empty tile list is declined rather than stored as a hole', () => {
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000 })
    expect(store.put(1, [])).toBe(false)
    expect(store.frameCount).toBe(0)
  })

  it('re-putting a frame replaces its tiles and keeps the byte tally exact', () => {
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000 })
    store.put(1, [tile(100), tile(100)])
    store.put(1, [tile(50)])
    expect(store.tileCount).toBe(1)
    expect(store.totalBytes).toBe(50)
  })

  it('clear() empties the store and the tally (idempotent)', () => {
    const store = new NativeTileStore({ budgetBytes: 1_000_000, ttlMs: 30_000 })
    store.put(1, [tile(100)])
    store.put(2, [tile(100)])
    store.clear()
    expect(store.frameCount).toBe(0)
    expect(store.totalBytes).toBe(0)
    store.clear()
    expect(store.totalBytes).toBe(0)
  })
})
