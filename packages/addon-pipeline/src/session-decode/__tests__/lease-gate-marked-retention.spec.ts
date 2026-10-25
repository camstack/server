/**
 * The activity gate must not free a frame the runner MARKED for inference.
 *
 * Live 2026-10-02: ~90/24h `toBuffer miss — released` with
 * `marked=true leaseFrames=0/8 holdOverflow=0` and `reserved = frameId + 1`.
 * The hold was empty because `LeaseActivityGate` closed after `activityMs`
 * without a native-crop request, and `captureNativeFrame` declined every
 * superseded marked frame before the lazy detection read. A mark is demand.
 */
import { describe, expect, it, vi } from 'vitest'
import { FrameSlot } from '../frame-slot.js'
import { LeaseActivityGate } from '../lease-activity-gate.js'
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
 * The worker's seam including the activity gate — the piece
 * `lease-admission-retention.spec.ts` left out and the live miss named.
 */
function buildGatedSeam(now: { t: number }) {
  const gate = new LeaseActivityGate(15_000, () => now.t)
  const ledger = new LeaseAdmissionLedger({ mode: 'inferred' })
  const store = new NativeLeaseStore<FakeFrame>({
    budgetBytes: 1024 * 1024 * 1024,
    // The hold bound is not what this spec is about: high enough never to evict.
    maxFrames: 10_000,
  })
  const capture = (frameId: number, frame: FakeFrame): boolean => {
    // Same order as `DecodeWorkerChild.captureNativeFrame`.
    if (!gate.active && !ledger.isMarked(frameId)) return false
    if (!ledger.admit(frameId)) return false
    return store.put(frameId, frame)
  }
  const slot = new FrameSlot<FakeFrame>({
    retainSuperseded: (frameId, frame) => capture(frameId, frame),
  })
  let ts = 0
  const deliver = (frame: FakeFrame, opts: { mark: boolean; arm: boolean }): number => {
    ts += 40
    slot.publish(frame, ts, 0)
    const reply = slot.pull()
    if (!reply) throw new Error('expected the slot to deliver')
    if (opts.mark) ledger.mark(reply.frameId)
    if (opts.arm) gate.arm()
    return reply.frameId
  }
  const resolve = (frameId: number): FakeFrame | null =>
    store.get(frameId) ?? slot.toBuffer(frameId)
  return { gate, ledger, store, deliver, resolve }
}

describe('activity gate vs marked-frame retention', () => {
  it('a cold gate frees an UNMARKED superseded frame (eager-download guard)', () => {
    const now = { t: 0 }
    const seam = buildGatedSeam(now)
    seam.gate.arm()
    now.t = 20_000
    expect(seam.gate.active).toBe(false)

    const dropped = mk('quiet-unmarked')
    const id = seam.deliver(dropped, { mark: false, arm: false })
    seam.deliver(mk('next'), { mark: false, arm: false })

    expect(seam.resolve(id)).toBeNull()
    expect(dropped.free).toHaveBeenCalledTimes(1)
    expect(seam.store.size).toBe(0)
  })

  it('a cold gate still retains a MARKED frame for the lazy detection toBuffer', () => {
    const now = { t: 20_000 }
    const seam = buildGatedSeam(now)
    expect(seam.gate.active).toBe(false)

    // Mark without arming — the bypass is `isMarked`, not a warm gate.
    const wanted = mk('marked-for-inference')
    const wantedId = seam.deliver(wanted, { mark: true, arm: false })
    expect(seam.gate.active).toBe(false)

    seam.deliver(mk('superseding'), { mark: false, arm: false })

    expect(seam.resolve(wantedId)?.label).toBe('marked-for-inference')
    expect(wanted.free).not.toHaveBeenCalled()
    expect(seam.store.size).toBe(1)
  })

  it('markInferred re-arms the gate so the next supersede captures under demand', () => {
    const now = { t: 20_000 }
    const seam = buildGatedSeam(now)
    expect(seam.gate.active).toBe(false)

    const wanted = mk('mark-arms')
    const wantedId = seam.deliver(wanted, { mark: true, arm: true })
    expect(seam.gate.active).toBe(true)

    seam.deliver(mk('superseding'), { mark: false, arm: false })

    expect(seam.resolve(wantedId)?.label).toBe('mark-arms')
    expect(seam.ledger.admitted).toBe(1)
  })
})
