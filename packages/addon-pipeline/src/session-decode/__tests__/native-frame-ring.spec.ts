import { describe, it, expect, vi } from 'vitest'
import { NativeFrameRing } from '../native-frame-ring.js'

const mk = () => ({ width: 1920, height: 1080, free: vi.fn() })

describe('NativeFrameRing', () => {
  it('retains up to the cap and hands back frames by id', () => {
    const ring = new NativeFrameRing(2)
    const f1 = mk()
    const f2 = mk()
    expect(ring.retain(1, f1)).toBe(true)
    expect(ring.retain(2, f2)).toBe(true)
    expect(ring.size).toBe(2)
    expect(ring.get(1)).toBe(f1)
    expect(ring.get(2)).toBe(f2)
    expect(f1.free).not.toHaveBeenCalled()
    expect(f2.free).not.toHaveBeenCalled()
  })

  it('evicts (frees) the OLDEST frame past the hard cap', () => {
    const ring = new NativeFrameRing(2)
    const f1 = mk()
    const f2 = mk()
    const f3 = mk()
    ring.retain(1, f1)
    ring.retain(2, f2)
    ring.retain(3, f3) // exceeds cap → oldest (id 1) evicted + freed
    expect(ring.size).toBe(2)
    expect(f1.free).toHaveBeenCalledTimes(1)
    expect(ring.get(1)).toBeNull() // evicted
    expect(ring.get(2)).toBe(f2)
    expect(ring.get(3)).toBe(f3)
  })

  it('a miss (never retained / already evicted) returns null', () => {
    const ring = new NativeFrameRing(1)
    expect(ring.get(99)).toBeNull()
    ring.retain(1, mk())
    expect(ring.get(2)).toBeNull()
  })

  it('capacity 0 DISABLES retention: retain returns false and never keeps a frame', () => {
    const ring = new NativeFrameRing(0)
    const f1 = mk()
    expect(ring.retain(1, f1)).toBe(false)
    expect(ring.size).toBe(0)
    expect(ring.get(1)).toBeNull()
    // Ownership was declined — the ring did NOT free it (caller owns it).
    expect(f1.free).not.toHaveBeenCalled()
  })

  it('clear() frees every retained frame and empties the ring (dispose guard)', () => {
    const ring = new NativeFrameRing(3)
    const frames = [mk(), mk(), mk()]
    frames.forEach((f, i) => ring.retain(i + 1, f))
    ring.clear()
    expect(ring.size).toBe(0)
    for (const f of frames) expect(f.free).toHaveBeenCalledTimes(1)
    // Idempotent — a second clear frees nothing new.
    ring.clear()
    for (const f of frames) expect(f.free).toHaveBeenCalledTimes(1)
  })

  it('a duplicate frameId frees the prior holder rather than leaking it', () => {
    const ring = new NativeFrameRing(2)
    const a = mk()
    const b = mk()
    ring.retain(1, a)
    ring.retain(1, b)
    expect(a.free).toHaveBeenCalledTimes(1)
    expect(ring.get(1)).toBe(b)
  })
})
