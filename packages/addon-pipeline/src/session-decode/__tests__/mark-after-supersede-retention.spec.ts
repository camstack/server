/**
 * Mark IPC after supersede: the reserved-slot margin does not cover this path.
 *
 * Live residual after the 1.2.317 activity-gate fix: `toBuffer miss — released`
 * with `marked=true leaseFrames=0` — the mark arrived after `retainSuperseded`
 * declined and freed the id; lazy detection still asked for that id.
 *
 * Disarm: park=false leaves the late mark with nothing to promote (same miss).
 */
import { describe, expect, it, vi } from 'vitest'
import { FrameSlot } from '../frame-slot.js'
import { LeaseActivityGate } from '../lease-activity-gate.js'
import { LeaseAdmissionLedger } from '../lease-admission-ledger.js'
import { NativeLeaseStore } from '../native-lease-store.js'
import { PendingMarkHold } from '../pending-mark-hold.js'

interface FakeFrame {
  readonly label: string
  readonly width: number
  readonly height: number
  readonly byteLength: number
  free(): void
}

const mk = (label: string): FakeFrame => ({
  label,
  width: 3840,
  height: 2160,
  byteLength: 24_883_200,
  free: vi.fn(),
})

/**
 * Worker seam including the pending-mark hold. `parkUnmarked` is the production
 * path; setting it false is the disarm that reproduces the live miss.
 */
function buildSeam(opts: { parkUnmarked: boolean; now?: { t: number } }) {
  const now = opts.now ?? { t: 0 }
  const gate = new LeaseActivityGate(15_000, () => now.t)
  const ledger = new LeaseAdmissionLedger({ mode: 'inferred' })
  const store = new NativeLeaseStore<FakeFrame>({
    budgetBytes: 1024 * 1024 * 1024,
    // The hold bound is not what this spec is about: high enough never to evict.
    maxFrames: 10_000,
  })
  const pending = new PendingMarkHold<FakeFrame>()

  const flushPending = (): void => {
    const id = pending.frameId
    if (id === null) return
    pending.discard()
    ledger.admit(id)
  }

  const capture = (frameId: number, frame: FakeFrame): boolean => {
    if (!gate.active && !ledger.isMarked(frameId)) {
      if (!opts.parkUnmarked) return false
      flushPending()
      pending.park(frameId, frame)
      return true
    }
    if (!ledger.wouldAdmit(frameId)) {
      if (!opts.parkUnmarked) return false
      flushPending()
      pending.park(frameId, frame)
      return true
    }
    flushPending()
    if (!ledger.admit(frameId)) return false
    return store.put(frameId, frame)
  }

  const markInferred = (frameId: number): void => {
    ledger.mark(frameId)
    gate.arm()
    const parked = pending.take(frameId)
    if (!parked) return
    if (!ledger.admit(frameId)) {
      parked.free()
      return
    }
    store.put(frameId, parked)
  }

  const slot = new FrameSlot<FakeFrame>({
    retainSuperseded: (frameId, frame) => capture(frameId, frame),
  })

  let ts = 0
  const deliver = (frame: FakeFrame): number => {
    ts += 40
    slot.publish(frame, ts, 0)
    const reply = slot.pull()
    if (!reply) throw new Error('expected the slot to deliver')
    return reply.frameId
  }

  const resolve = (frameId: number): FakeFrame | null =>
    store.get(frameId) ?? pending.get(frameId) ?? slot.toBuffer(frameId)

  return { gate, ledger, store, pending, deliver, markInferred, resolve, flushPending }
}

describe('PendingMarkHold', () => {
  it('parks one frame and discards the previous on a newer park', () => {
    const hold = new PendingMarkHold<FakeFrame>()
    const first = mk('first')
    const second = mk('second')
    hold.park(1, first)
    hold.park(2, second)
    expect(first.free).toHaveBeenCalledTimes(1)
    expect(hold.take(2)?.label).toBe('second')
    expect(hold.size).toBe(0)
  })

  it('get peeks; take transfers; mismatch leaves the hold', () => {
    const hold = new PendingMarkHold<FakeFrame>()
    const frame = mk('held')
    hold.park(7, frame)
    expect(hold.get(7)?.label).toBe('held')
    expect(hold.take(8)).toBeNull()
    expect(hold.size).toBe(1)
    expect(hold.take(7)?.label).toBe('held')
    expect(frame.free).not.toHaveBeenCalled()
  })
})

describe('mark after supersede — pending hold', () => {
  it('a mark that lands after supersede still retains for lazy toBuffer', () => {
    const seam = buildSeam({ parkUnmarked: true })
    seam.gate.arm()

    const wanted = mk('late-mark')
    const wantedId = seam.deliver(wanted)
    // Next pull supersedes BEFORE the mark IPC — the residual race.
    seam.deliver(mk('superseding'))
    expect(seam.store.get(wantedId)).toBeNull()
    expect(seam.pending.frameId).toBe(wantedId)

    seam.markInferred(wantedId)

    expect(seam.resolve(wantedId)?.label).toBe('late-mark')
    expect(wanted.free).not.toHaveBeenCalled()
    expect(seam.pending.size).toBe(0)
    expect(seam.store.size).toBe(1)
  })

  it('disarm: without the pending hold a late mark finds nothing to lease', () => {
    const seam = buildSeam({ parkUnmarked: false })
    seam.gate.arm()

    const wanted = mk('freed-before-mark')
    const wantedId = seam.deliver(wanted)
    seam.deliver(mk('superseding'))
    expect(wanted.free).toHaveBeenCalledTimes(1)

    seam.markInferred(wantedId)

    expect(seam.resolve(wantedId)).toBeNull()
    expect(seam.ledger.isMarked(wantedId)).toBe(true)
    expect(seam.store.size).toBe(0)
  })

  it('an unmarked pending is freed on the next supersede (one-frame grace only)', () => {
    const seam = buildSeam({ parkUnmarked: true })
    seam.gate.arm()

    const dropped = mk('never-marked')
    const droppedId = seam.deliver(dropped)
    seam.deliver(mk('second'))
    expect(seam.pending.frameId).toBe(droppedId)
    expect(dropped.free).not.toHaveBeenCalled()

    seam.deliver(mk('third'))
    expect(dropped.free).toHaveBeenCalledTimes(1)
    expect(seam.pending.frameId).not.toBe(droppedId)
  })

  it('cold gate + mark after supersede still promotes (gate fix + pending)', () => {
    const now = { t: 20_000 }
    const seam = buildSeam({ parkUnmarked: true, now })
    expect(seam.gate.active).toBe(false)

    const wanted = mk('cold-late-mark')
    const wantedId = seam.deliver(wanted)
    seam.deliver(mk('superseding'))
    seam.markInferred(wantedId)

    expect(seam.resolve(wantedId)?.label).toBe('cold-late-mark')
    expect(seam.gate.active).toBe(true)
  })
})
