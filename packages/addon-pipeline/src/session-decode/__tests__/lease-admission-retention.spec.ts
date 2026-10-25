/**
 * The three parts of the admission path composed the way the decode worker
 * composes them: `FrameSlot` decides WHICH frame is offered,
 * `LeaseAdmissionLedger` decides whether it is kept, `NativeLeaseStore` holds
 * it. Each is unit-tested alone; this pins the thing that actually has to be
 * true — **a crop for a marked frame still hits after its unmarked siblings
 * were dropped**.
 *
 * That is the regression the filter can produce and no single unit can catch: a
 * ledger that dropped the wrong frame, or a slot that offered the wrong id,
 * would leave every unit test green and every late crop missing.
 *
 * The fake frame carries a `label` so a wrong-frame retention is visible as a
 * wrong VALUE, not merely as a wrong count — two identical fakes are
 * indistinguishable by reading, which is how a copy bug survives a test suite.
 */
import { describe, expect, it, vi } from 'vitest'
import { FrameSlot } from '../frame-slot.js'
import { LeaseAdmissionLedger } from '../lease-admission-ledger.js'
import { NativeLeaseStore } from '../native-lease-store.js'

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
 * The worker's wiring: the slot offers a superseded DELIVERED frame, the ledger
 * decides, the store takes ownership. Returns the pieces plus a `deliver` that
 * plays one publish+pull cycle and optionally marks the delivered frame.
 */
function buildWorkerSeam(mode: 'all' | 'inferred') {
  const ledger = new LeaseAdmissionLedger({ mode })
  const store = new NativeLeaseStore<FakeFrame>({ budgetBytes: 1024 * 1024 * 1024, maxFrames: 256 })
  const slot = new FrameSlot<FakeFrame>({
    retainSuperseded: (frameId, frame) => {
      if (!ledger.admit(frameId)) return false
      return store.put(frameId, frame)
    },
  })
  let ts = 0
  /** Publish + pull one frame; `inferred` marks it the way the runner does. */
  const deliver = (frame: FakeFrame, inferred: boolean): number => {
    ts += 40
    slot.publish(frame, ts, 0)
    const reply = slot.pull()
    if (!reply) throw new Error('expected the slot to deliver')
    if (inferred) ledger.mark(reply.frameId)
    return reply.frameId
  }
  /** What `handleNativeCrop` does: lease first, then the still-reserved slot. */
  const resolveCrop = (frameId: number): FakeFrame | null =>
    store.get(frameId) ?? slot.toBuffer(frameId)
  return { ledger, store, slot, deliver, resolveCrop }
}

describe('lease admission end to end (slot → ledger → store)', () => {
  // Measured 2026-09-06: with inference at ~74 ms and frames every ~125 ms the
  // runner's RELEASE for a frame reaches the worker BEFORE the next pull
  // supersedes it — the lease is then put AFTER its release and stays pinned
  // until the bound evicts it (releaseMisses ≈ admitted, holdOverflow ≈
  // admitted − 8 on every busy worker). A release that finds no lease must
  // UNMARK the frame, so the supersede declines it and frees it.
  it('a release that arrives before the supersede leaves the frame UNLEASED and freed', () => {
    const { ledger, store, deliver } = buildWorkerSeam('inferred')
    const early = mk('done-before-supersede')
    const id = deliver(early, true)
    // The runner is done with it before the next frame arrives.
    if (!store.release(id)) ledger.unmark(id)
    deliver(mk('next'), true)
    expect(store.get(id)).toBeNull()
    expect(early.free).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(0)
  })

  it('a crop for a MARKED frame hits after four unmarked siblings were dropped', () => {
    const seam = buildWorkerSeam('inferred')
    const wanted = mk('inferred-frame')
    const wantedId = seam.deliver(wanted, true)
    // Four governed frames follow — delivered to the runner, never enqueued.
    for (let i = 0; i < 4; i++) seam.deliver(mk(`governed-${i}`), false)
    // One more so the last governed frame is itself superseded and judged.
    seam.deliver(mk('governed-4'), false)

    const resolved = seam.resolveCrop(wantedId)
    expect(resolved?.label).toBe('inferred-frame')
    expect(seam.store.size).toBe(1)
    expect(seam.ledger.offered).toBe(5)
    expect(seam.ledger.admitted).toBe(1)
  })

  it('the unmarked siblings were FREED, not leaked — the slot handed ownership back', () => {
    const seam = buildWorkerSeam('inferred')
    seam.deliver(mk('inferred-frame'), true)
    const governed = mk('governed')
    seam.deliver(governed, false)
    seam.deliver(mk('next'), false)
    expect(governed.free).toHaveBeenCalledTimes(1)
  })

  it('the NEWEST delivered frame is croppable even unmarked — it is the reserved slot, not a lease', () => {
    const seam = buildWorkerSeam('inferred')
    seam.deliver(mk('older'), true)
    const newestId = seam.deliver(mk('newest-unmarked'), false)
    expect(seam.store.get(newestId)).toBeNull()
    expect(seam.resolveCrop(newestId)?.label).toBe('newest-unmarked')
  })

  it('in "all" mode nothing changes — every delivered frame is still leased', () => {
    const seam = buildWorkerSeam('all')
    const ids = [
      seam.deliver(mk('a'), true),
      seam.deliver(mk('b'), false),
      seam.deliver(mk('c'), false),
    ]
    seam.deliver(mk('d'), false)
    for (const id of ids) expect(seam.resolveCrop(id)).not.toBeNull()
    expect(seam.store.size).toBe(3)
  })

  it('measures the saving: 1 of every 5 delivered frames retained at the governor ratio', () => {
    const seam = buildWorkerSeam('inferred')
    for (let i = 0; i < 25; i++) seam.deliver(mk(`f${i}`), i % 5 === 0)
    seam.deliver(mk('flush'), false)
    expect(seam.ledger.offered).toBe(25)
    expect(seam.ledger.admitted).toBe(5)
    expect(seam.store.totalBytes).toBe(5 * 24_883_200)
  })
})
