/**
 * An operation the queue abandons at its deadline (fix round 2, N1, the
 * re-review's probes P5 and P6).
 *
 *  - P6: a promotion whose read outlives the deadline is rejected to the
 *    caller — and must then write NOTHING: no file, no row, no pin. The queue
 *    aborts the op's `AbortSignal`, and every write phase checks it first.
 *  - P5: a release whose unpin is in flight when the deadline passes cannot be
 *    recalled; it lands after the next promotion of the same tracks has pinned
 *    them. The tracks of an UNRELEASED row must end pinned anyway: reconcile
 *    re-applies the pins of every row, settled or not, and the queue runs one
 *    as soon as an abandoned op finally settles.
 *
 * Disarms:
 *  - drop the signal checks (`throwIfAborted`) in `promoteTapeWindow` — "a
 *    promotion abandoned at its deadline writes nothing" fails;
 *  - restore reconcile's unsettled-only filter — "a late unpin is repaired by
 *    the next operation" fails;
 *  - drop the queue's follow-up after an abandoned op settles — "a late unpin
 *    is repaired without waiting for an operator" fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import { TapeOperationQueue, TapeOperationTimeoutError } from '../tape-operation-queue.js'
import { reconcileTapePins, releaseTape } from '../tape-pin-ledger.js'
import { promoteTapeWindow } from '../tape-promotion.js'
import { flush, gate, ORIGIN, type World, until, world } from './promotion-world.js'

/**
 * The queue's deadline is the only clock in these scenarios, and it must be a
 * clock the test turns: with the real one, a loaded CI runner let the 20 ms
 * deadline expire BEFORE the release reached its unpin (the gate is captured at
 * call time), so the unpin was never held, landed before promotion B, and
 * "a late unpin is repaired" saw a pin that was never lost (run 38359285595).
 * Only `setTimeout` is faked — the world yields on `setImmediate`.
 */
const DEADLINE_MS = 20

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

const INPUT = { deviceId: 101, fromMs: ORIGIN, toMs: ORIGIN + 1_000, scenario: 'ok-slug' }

function queueFor(w: World, followUp: boolean): TapeOperationQueue {
  return new TapeOperationQueue({
    logger: makeLogRecorder().logger,
    deadlineMs: DEADLINE_MS,
    ...(followUp ? { afterAbandoned: () => reconcileTapePins(w.deps) } : {}),
  })
}

/** P5 up to the late unpin: A promoted, A's release abandoned mid-unpin, B
 *  promoted over the same tracks, then the hung unpin lands. */
async function lateUnpinAfterNextPromote(w: World, queue: TapeOperationQueue): Promise<void> {
  await queue.run((signal) => promoteTapeWindow(w.deps, INPUT, signal), { name: 'promote' })
  const hang = gate()
  w.faults.unpinGate = hang.wait
  const release = queue.run((signal) => releaseTape(w.deps, 'promo-0001', signal), {
    name: 'release',
  })
  const abandoned = expect(release).rejects.toBeInstanceOf(TapeOperationTimeoutError)
  // The unpin is in flight (parked on the gate) BEFORE the deadline may pass.
  await until(() => w.faults.unpinsHeld === 1, 'the release parked on its unpin')
  await vi.advanceTimersByTimeAsync(DEADLINE_MS)
  await abandoned
  w.faults.unpinGate = null
  const b = await queue.run((signal) => promoteTapeWindow(w.deps, INPUT, signal), {
    name: 'promote',
  })
  expect(b).toMatchObject({ ok: true, tapeId: 'promo-0002' })
  expect(w.pins.get('trk-a')).toBe(true)
  hang.open()
  await flush()
}

describe('abandoned tape operations', () => {
  it('a promotion abandoned at its deadline writes nothing (P6)', async () => {
    const w = await world()
    const queue = queueFor(w, false)
    const slow = gate()
    w.faults.readGate = slow.wait
    const promote = queue.run((signal) => promoteTapeWindow(w.deps, INPUT, signal), {
      name: 'promote',
    })
    const abandoned = expect(promote).rejects.toBeInstanceOf(TapeOperationTimeoutError)
    // The read is parked on the gate BEFORE the deadline may pass.
    await until(() => w.reads.length > 0, 'the promotion parked on its read')
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    await abandoned
    slow.open()
    await flush()
    expect(w.written.size).toBe(0)
    expect(await w.index.list()).toEqual([])
    expect(w.pins.size).toBe(0)
  })

  it('a late unpin is repaired by the next operation (P5)', async () => {
    const w = await world()
    const queue = queueFor(w, false)
    await lateUnpinAfterNextPromote(w, queue)
    // The late unpin has landed over B's live promotion…
    expect(w.pins.get('trk-a')).toBe(false)
    await queue.run((signal) => reconcileTapePins(w.deps, signal), { name: 'reconcile' })
    expect(w.pins.get('trk-a')).toBe(true)
    expect(w.pins.get('trk-b')).toBe(true)
  })

  it('a late unpin is repaired without waiting for an operator (P5)', async () => {
    const w = await world()
    const queue = queueFor(w, true)
    await lateUnpinAfterNextPromote(w, queue)
    expect(w.pins.get('trk-a')).toBe(true)
    expect(w.pins.get('trk-b')).toBe(true)
  })
})
