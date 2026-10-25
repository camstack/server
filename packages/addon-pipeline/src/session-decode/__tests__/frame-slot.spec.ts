import { describe, it, expect, vi } from 'vitest'
import { FrameSlot } from '../frame-slot.js'

const mk = () => ({ width: 4, height: 4, free: vi.fn() })

describe('FrameSlot', () => {
  it('pull reserves the frame so toBuffer resolves it', () => {
    const s = new FrameSlot()
    const f1 = mk()
    s.publish(f1, 10, 0)
    const reply = s.pull()
    expect(reply).not.toBeNull()
    expect(s.toBuffer(reply!.frameId)).toBe(f1)
    expect(f1.free).not.toHaveBeenCalled()
  })

  it('a second pull frees the prior reserved frame; stale toBuffer returns null', () => {
    const s = new FrameSlot()
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 10, 0)
    const r1 = s.pull()!
    s.publish(f2, 20, 0)
    const r2 = s.pull()!
    expect(f1.free).toHaveBeenCalledTimes(1)
    expect(s.toBuffer(r1.frameId)).toBeNull() // stale → child sends error{frameId:r1}
    expect(s.toBuffer(r2.frameId)).toBe(f2)
  })

  it('latest-wins: two publishes without a pull free the older frame', () => {
    const s = new FrameSlot()
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 10, 0)
    s.publish(f2, 20, 0)
    expect(f1.free).toHaveBeenCalledTimes(1)
    const reply = s.pull()
    expect(s.toBuffer(reply!.frameId)).toBe(f2)
  })

  it('minIntervalMs throttle: a publish within the interval is dropped', () => {
    const s = new FrameSlot()
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 1000, 100)
    const reply1 = s.pull()
    expect(reply1).not.toBeNull()
    // A continuously pending consumer leaves the slot empty. Throttling must
    // still use the last admitted timestamp rather than the slot's presence.
    s.markPendingPull()
    expect(s.publish(f2, 1050, 100)).toBeNull()
    expect(f2.free).toHaveBeenCalledTimes(1)

    const f3 = mk()
    const reply2 = s.publish(f3, 1100, 100)
    expect(reply2).not.toBeNull()
    expect(s.toBuffer(reply2!.frameId)).toBe(f3)
  })

  it('free() frees both slot and reserved', () => {
    const s = new FrameSlot()
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 10, 0)
    s.pull() // f1 reserved
    s.publish(f2, 20, 0) // f2 in slot (unpulled)
    s.free()
    expect(f1.free).toHaveBeenCalledTimes(1)
    expect(f2.free).toHaveBeenCalledTimes(1)
  })

  it('markPendingPull then publish resolves the pending pull and reserves the frame', () => {
    const s = new FrameSlot()
    expect(s.pull()).toBeNull()
    s.markPendingPull()
    const f = mk()
    const reply = s.publish(f, 10, 0)
    expect(reply).not.toBeNull()
    expect(s.toBuffer(reply!.frameId)).toBe(f)
    expect(f.free).not.toHaveBeenCalled()
  })
})
