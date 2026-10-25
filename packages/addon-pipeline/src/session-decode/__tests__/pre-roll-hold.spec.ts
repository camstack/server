/**
 * D652 — pre-roll frames must fit the hold they live in.
 *
 * A pre-roll frame reaches the runner as a lazy ref: its pixels are a frame
 * the worker HOLDS until inference reads it. The hold is `holdFrames` deep
 * (8), the burst admitted up to `preRollInferenceFrames` (12) and the lane
 * reads them oldest-first — so the burst evicted its own oldest frames before
 * inference reached them. Live: 54 of 55 `toBuffer miss … released/hold-full`
 * lines named a frameId ≤ 12.
 *
 * The choice (ADR D652): cap the frames the burst SENDS to inference at
 * `holdFrames - 1`, and spread them over the reach the operator asked for.
 * The history the consumer asked for (D382) is unchanged — the same span of
 * media is covered, sampled less densely. Raising the hold instead would pin
 * extra native rasters (~24 MB each at 4K) on every session open, the exact
 * allocation D9/D18 forbid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeLeaseStore } from '../native-lease-store.js'
import { planPreRollWithinHold } from '../pre-roll-burst.js'
import { PreRollSettleTracker } from '../pre-roll-hold-ledger.js'
import {
  OutboundSendTracker,
  WORKER_EXIT_FLUSH_BOUND_MS,
  type WorkerExitEvent,
  createWorkerExit,
  FaultReporter,
  wireWorkerExit,
} from '../bounded-exit.js'
import { inputCloseAfterLoop, releaseFrameAfterStop } from '../decode-loop-policy.js'
import { FrameSlot } from '../frame-slot.js'

describe('planPreRollWithinHold', () => {
  it('caps the burst at holdFrames - 1 and keeps the REACH the operator asked for', () => {
    const p = planPreRollWithinHold({
      requestedFrames: 12,
      cadenceMs: 100,
      holdFrames: 8,
      holdEnabled: true,
    })
    expect(p.budgetFrames).toBe(7)
    expect(p.holdCapped).toBe(true)
    expect(p.plan.plannedFrames).toBe(7)
    // 12 frames at 100 ms asked for 1 200 ms of history; 7 frames still span it.
    expect(p.plan.strideMs * p.plan.plannedFrames).toBeCloseTo(1_200, 0)
    expect(p.plan.subsampled).toBe(true)
  })

  it('a budget that already fits the hold is untouched — same cadence, same frames', () => {
    const p = planPreRollWithinHold({
      requestedFrames: 5,
      cadenceMs: 100,
      holdFrames: 8,
      holdEnabled: true,
    })
    expect(p.budgetFrames).toBe(5)
    expect(p.holdCapped).toBe(false)
    expect(p.plan.strideMs).toBe(100)
    expect(p.plan.subsampled).toBe(false)
  })

  it('with the hold DISABLED there is no hold to overflow — the budget is the ask', () => {
    const p = planPreRollWithinHold({
      requestedFrames: 12,
      cadenceMs: 100,
      holdFrames: 8,
      holdEnabled: false,
    })
    expect(p.budgetFrames).toBe(12)
    expect(p.holdCapped).toBe(false)
  })

  it('never caps below one frame', () => {
    const p = planPreRollWithinHold({
      requestedFrames: 12,
      cadenceMs: 100,
      holdFrames: 1,
      holdEnabled: true,
    })
    expect(p.budgetFrames).toBe(1)
  })

  it('no ask, no burst', () => {
    const p = planPreRollWithinHold({
      requestedFrames: 0,
      cadenceMs: 100,
      holdFrames: 8,
      holdEnabled: true,
    })
    expect(p.budgetFrames).toBe(0)
    expect(p.plan.plannedFrames).toBe(0)
  })
})

describe("PreRollSettleTracker — the late fate of the burst's frames", () => {
  const zero = { evicted: 0, cleared: 0, 'download-failed': 0, miss: 0 }

  it('sends nothing while frames are owed, then ONE summary once they all settled', () => {
    const t = new PreRollSettleTracker()
    t.admit(1)
    t.admit(2)
    t.admit(3)
    expect(t.endBurst()).toBeNull()
    expect(t.settle(1, 'read')).toBeNull()
    expect(t.settle(2, 'evicted')).toBeNull()
    expect(t.settle(3, 'released')).toEqual({
      read: 1,
      released: 1,
      lostByReason: { ...zero, evicted: 1 },
      unsettled: 0,
    })
    expect(t.flush()).toBeNull()
  })

  it('names every way a frame is lost: evicted, cleared, download-failed, miss', () => {
    const t = new PreRollSettleTracker()
    for (const id of [1, 2, 3, 4, 5]) t.admit(id)
    t.endBurst()
    t.settle(1, 'evicted')
    t.settle(2, 'download-failed')
    t.settle(3, 'miss')
    const summary = t.settleAll('cleared')
    expect(summary?.lostByReason).toEqual({
      evicted: 1,
      cleared: 2,
      'download-failed': 1,
      miss: 1,
    })
  })

  it('only the FIRST outcome counts — the miss that follows an eviction is the same loss', () => {
    const t = new PreRollSettleTracker()
    t.admit(1)
    t.endBurst()
    const summary = t.settle(1, 'evicted')
    expect(t.settle(1, 'miss')).toBeNull()
    expect(summary?.lostByReason).toEqual({ ...zero, evicted: 1 })
  })

  it('frames that are not pre-roll are ignored', () => {
    const t = new PreRollSettleTracker()
    t.admit(1)
    expect(t.settle(99, 'evicted')).toBeNull()
    t.endBurst()
    expect(t.settle(1, 'read')?.lostByReason).toEqual(zero)
  })

  it('teardown sends what is known, unsettled included — exactly once', () => {
    const t = new PreRollSettleTracker()
    t.admit(1)
    t.admit(2)
    t.endBurst()
    t.settle(1, 'read')
    expect(t.flush()).toEqual({ read: 1, released: 0, lostByReason: zero, unsettled: 1 })
    expect(t.flush()).toBeNull()
  })

  it('no burst, no line', () => {
    const t = new PreRollSettleTracker()
    expect(t.flush()).toBeNull()
  })
})

describe('bounded worker exit — the last lines leave before the process does', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('quiesces, flushes the final lines, waits for them to leave, then exits — in that order', async () => {
    const sends = new OutboundSendTracker()
    const order: string[] = []
    let done: (() => void) | undefined
    const shutdown = createWorkerExit({
      sends,
      steps: {
        quiesce: () => order.push('quiesce'),
        flushFinalLines: () => {
          order.push('flush')
          done = sends.begin() // the pre-roll line
        },
      },
      exit: (code) => order.push(`exit:${code}`),
    })
    shutdown(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(order).toEqual(['quiesce', 'flush'])
    if (done !== undefined) done()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['quiesce', 'flush', 'exit:0'])
  })

  it('never waits past the bound — a stuck channel cannot hold the worker', async () => {
    const sends = new OutboundSendTracker()
    const exit = vi.fn()
    const shutdown = createWorkerExit({
      sends,
      steps: { quiesce: () => undefined, flushFinalLines: () => void sends.begin() },
      exit,
    })
    shutdown(0)
    await vi.advanceTimersByTimeAsync(WORKER_EXIT_FLUSH_BOUND_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledTimes(1)
    // …and the bound sits inside the parent's 1 s SIGKILL fallback.
    expect(WORKER_EXIT_FLUSH_BOUND_MS).toBeLessThan(1_000)
  })

  it('SIGTERM, stop and disconnect for one shutdown quiesce and exit once', async () => {
    const sends = new OutboundSendTracker()
    const exit = vi.fn()
    const quiesce = vi.fn()
    const shutdown = createWorkerExit({
      sends,
      steps: { quiesce, flushFinalLines: () => undefined },
      exit,
    })
    shutdown(0)
    shutdown(0)
    shutdown(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(quiesce).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('wires SIGTERM and disconnect to exit 0, an uncaught error to report + exit 1 (M-A)', () => {
    const listeners = new Map<WorkerExitEvent, (arg: unknown) => void>()
    const exitWorker = vi.fn()
    const reportFault = vi.fn()
    wireWorkerExit({
      on: (event, listener) => listeners.set(event, listener),
      exitWorker,
      faults: new FaultReporter(reportFault, () => undefined),
      onStdioLost: () => undefined,
      parentConnected: () => true,
    })
    // D666 added stdio loss, the ppid watchdog and unhandled rejections.
    expect([...listeners.keys()].sort()).toEqual([
      'SIGTERM',
      'disconnect',
      'parentChanged',
      'stdioLost',
      'uncaughtException',
      'unhandledRejection',
    ])
    listeners.get('SIGTERM')?.(undefined)
    expect(exitWorker).toHaveBeenLastCalledWith(0, 'flush')
    // The parent is gone: nothing to flush to, exit in the same turn (D666).
    listeners.get('disconnect')?.(undefined)
    expect(exitWorker).toHaveBeenLastCalledWith(0, 'now')
    const boom = new Error('boom')
    listeners.get('uncaughtException')?.(boom)
    expect(reportFault).toHaveBeenCalledWith('uncaughtException', boom)
    expect(exitWorker).toHaveBeenLastCalledWith(1, 'flush')
  })
})

describe('decode-loop policy — what may be disposed, and when (I-A, M5)', () => {
  it('re-dial closes everything; drain only the demuxer; exit nothing', () => {
    expect(inputCloseAfterLoop({ draining: false, exiting: false })).toBe('all')
    expect(inputCloseAfterLoop({ draining: true, exiting: false })).toBe('demuxer-only')
    expect(inputCloseAfterLoop({ draining: false, exiting: true })).toBe('none')
    // An exit during a drain is still an exit: nothing native.
    expect(inputCloseAfterLoop({ draining: true, exiting: true })).toBe('none')
  })

  it('the frame decoded after a stop is freed on a drain, left to exit on exit', () => {
    const f = { free: vi.fn() }
    releaseFrameAfterStop(f, { draining: true, exiting: false })
    expect(f.free).toHaveBeenCalledTimes(1)
    const g = { free: vi.fn() }
    releaseFrameAfterStop(g, { draining: true, exiting: true })
    expect(g.free).not.toHaveBeenCalled()
    expect(() => releaseFrameAfterStop(null, { draining: true, exiting: false })).not.toThrow()
  })
})

describe('FrameSlot.freeUndelivered — a drain frees only what no read can want', () => {
  const mk = () => ({ width: 2, height: 2, free: vi.fn() })

  it('frees the undelivered slot frame and keeps the reserved one', () => {
    const slot = new FrameSlot()
    const delivered = mk()
    slot.markPendingPull()
    const reply = slot.publish(delivered, 1, 0)
    const undelivered = mk()
    slot.publish(undelivered, 2, 0)
    expect(slot.freeUndelivered()).toBe(true)
    expect(undelivered.free).toHaveBeenCalledTimes(1)
    expect(delivered.free).not.toHaveBeenCalled()
    expect(reply && slot.toBuffer(reply.frameId)).toBe(delivered)
    expect(slot.freeUndelivered()).toBe(false)
  })
})

describe('NativeLeaseStore — evictions are reported by frameId', () => {
  it('names the frame the hold bound evicted, and only that', () => {
    const onEvict = vi.fn()
    const store = new NativeLeaseStore({ budgetBytes: 1_000_000, maxFrames: 2, onEvict })
    const mk = () => ({ byteLength: 10, free: vi.fn() })
    store.put(1, mk())
    store.put(2, mk())
    store.release(2)
    expect(onEvict).not.toHaveBeenCalled()
    store.put(3, mk())
    store.put(4, mk())
    expect(onEvict).toHaveBeenCalledExactlyOnceWith(1)
  })
})
