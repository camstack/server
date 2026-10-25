import { describe, it, expect, vi } from 'vitest'
import { FrameSlot } from '../frame-slot.js'

const mk = () => ({ width: 4, height: 4, free: vi.fn() })

describe('FrameSlot retainSuperseded hook (native-crop retention seam)', () => {
  it('hands a superseded DELIVERED frame to the hook instead of freeing it (ownership transfer)', () => {
    const retained: Array<{ id: number; frame: ReturnType<typeof mk> }> = []
    const s = new FrameSlot<ReturnType<typeof mk>>({
      retainSuperseded: (id, frame) => {
        retained.push({ id, frame })
        return true // ring takes ownership
      },
    })
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 10, 0)
    const r1 = s.pull()! // reserves f1
    s.publish(f2, 20, 0)
    s.pull()! // reserves f2, supersedes f1 → offered to the hook
    expect(retained).toEqual([{ id: r1.frameId, frame: f1 }])
    // The hook took ownership, so the slot did NOT free f1.
    expect(f1.free).not.toHaveBeenCalled()
  })

  it('falls back to freeing when the hook DECLINES ownership (returns false)', () => {
    const s = new FrameSlot<ReturnType<typeof mk>>({
      retainSuperseded: () => false, // ring disabled / full — decline
    })
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 10, 0)
    s.pull()!
    s.publish(f2, 20, 0)
    s.pull()!
    // Declined → same as today's behaviour: the slot freed the superseded frame.
    expect(f1.free).toHaveBeenCalledTimes(1)
  })

  it('with no hook, behaviour is unchanged (superseded reserved frame freed)', () => {
    const s = new FrameSlot<ReturnType<typeof mk>>()
    const f1 = mk()
    const f2 = mk()
    s.publish(f1, 10, 0)
    s.pull()!
    s.publish(f2, 20, 0)
    s.pull()!
    expect(f1.free).toHaveBeenCalledTimes(1)
  })
})
