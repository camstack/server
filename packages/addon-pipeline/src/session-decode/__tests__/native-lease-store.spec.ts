import { describe, expect, it, vi } from 'vitest'
import { type LeasedNativeFrame, NativeLeaseStore } from '../native-lease-store.js'

/** A fake held frame with a fixed byte size and a spyable `free`. */
const mk = (byteLength: number): LeasedNativeFrame & { free: ReturnType<typeof vi.fn> } => ({
  byteLength,
  free: vi.fn(),
})

/** A controllable clock — used only for the age report, never for expiry. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('NativeLeaseStore — the HOLD', () => {
  it('serves a held frame (the hit path)', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1024, maxFrames: 8 })
    const f = mk(100)
    expect(store.put(1, f)).toBe(true)
    expect(store.get(1)).toBe(f)
    expect(store.size).toBe(1)
    expect(store.totalBytes).toBe(100)
    expect(f.free).not.toHaveBeenCalled()
  })

  it('a miss (never held / already released) returns null → caller falls back', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1024, maxFrames: 8 })
    expect(store.get(99)).toBeNull()
    store.put(1, mk(10))
    expect(store.get(2)).toBeNull()
  })

  // The lifetime contract, and the reason the TTL is gone: a frame is waiting
  // for ONE event (its own detection result). Time passing is not that event.
  it('does NOT expire on a clock — the hold outlives any TTL that used to bound it', () => {
    const clock = fakeClock()
    const store = new NativeLeaseStore({ budgetBytes: 1024, maxFrames: 8, now: clock.now })
    const f = mk(100)
    store.put(1, f)
    clock.advance(60_000) // fifty times the old 1 200 ms TTL
    expect(store.get(1)).toBe(f)
    expect(f.free).not.toHaveBeenCalled()
    expect(store.ageMs(1)).toBe(60_000)
  })

  it('release(frameId) is the ORDINARY exit: the result arrived, the frame is freed', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1024, maxFrames: 8 })
    const f = mk(100)
    store.put(1, f)
    store.release(1)
    expect(f.free).toHaveBeenCalledTimes(1)
    expect(store.get(1)).toBeNull()
    expect(store.size).toBe(0)
    expect(store.overflowCount).toBe(0) // a release is not an overflow
    // Releasing an unknown id is a harmless no-op.
    store.release(42)
  })

  it('the HOLD BOUND drops the oldest frame whose result never came back, and COUNTS it', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1_000_000, maxFrames: 2 })
    const f1 = mk(100)
    const f2 = mk(100)
    const f3 = mk(100)
    store.put(1, f1)
    store.put(2, f2)
    store.put(3, f3) // 3 held > bound 2 → oldest (id 1) dropped
    expect(store.size).toBe(2)
    expect(f1.free).toHaveBeenCalledTimes(1)
    expect(store.get(1)).toBeNull()
    expect(store.get(2)).toBe(f2)
    expect(store.get(3)).toBe(f3)
    // Non-zero means the runner is not keeping up — a different sentence from
    // "the crop was late", which is why it is a counter and not silence.
    expect(store.overflowCount).toBe(1)
  })

  it('a released frame gives its slot back, so a steady runner never overflows', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1_000_000, maxFrames: 2 })
    for (let id = 1; id <= 20; id += 1) {
      store.put(id, mk(100))
      store.release(id) // the result came back before the next frame
    }
    expect(store.size).toBe(0)
    expect(store.overflowCount).toBe(0)
  })

  it('the BYTE ceiling still evicts oldest-first, and also counts as overflow', () => {
    const store = new NativeLeaseStore({ budgetBytes: 250, maxFrames: 64 })
    const f1 = mk(100)
    const f2 = mk(100)
    const f3 = mk(100)
    store.put(1, f1)
    store.put(2, f2)
    store.put(3, f3) // 300 > 250 → oldest (id 1) evicted + freed
    expect(store.totalBytes).toBe(200)
    expect(f1.free).toHaveBeenCalledTimes(1)
    expect(store.overflowCount).toBe(1)
  })

  it('never evicts the frame it just admitted, even when that frame alone exceeds the budget', () => {
    const store = new NativeLeaseStore({ budgetBytes: 50, maxFrames: 8 })
    const big = mk(1000)
    expect(store.put(1, big)).toBe(true)
    expect(store.get(1)).toBe(big)
    expect(big.free).not.toHaveBeenCalled()
  })

  it('budget 0 DISABLES the hold: put frees immediately and returns false', () => {
    const store = new NativeLeaseStore({ budgetBytes: 0, maxFrames: 8 })
    expect(store.enabled).toBe(false)
    const f = mk(100)
    expect(store.put(1, f)).toBe(false)
    expect(f.free).toHaveBeenCalledTimes(1) // caller-declined ownership is freed here
    expect(store.get(1)).toBeNull()
    expect(store.size).toBe(0)
  })

  it('clear() frees every held frame and empties the store (dispose guard, idempotent)', () => {
    const store = new NativeLeaseStore({ budgetBytes: 4096, maxFrames: 8 })
    const frames = [mk(100), mk(100), mk(100)]
    frames.forEach((f, i) => store.put(i + 1, f))
    store.clear()
    expect(store.size).toBe(0)
    expect(store.totalBytes).toBe(0)
    for (const f of frames) expect(f.free).toHaveBeenCalledTimes(1)
    store.clear()
    for (const f of frames) expect(f.free).toHaveBeenCalledTimes(1)
  })

  it('a duplicate frameId frees the prior holder rather than leaking it', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1024, maxFrames: 8 })
    const a = mk(100)
    const b = mk(100)
    store.put(1, a)
    store.put(1, b)
    expect(a.free).toHaveBeenCalledTimes(1)
    expect(store.get(1)).toBe(b)
    expect(store.totalBytes).toBe(100)
  })

  it('ageMs is null for a frame that is not held', () => {
    const store = new NativeLeaseStore({ budgetBytes: 1024, maxFrames: 8 })
    expect(store.ageMs(1)).toBeNull()
  })
})
