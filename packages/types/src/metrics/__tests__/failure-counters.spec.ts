/**
 * `FailureCounters` — the invariants the whole `failure-contribution` surface
 * rests on.
 *
 * Every assertion here is about an OUTCOME an operator would read, not about a
 * call being made: which camera's counter moved, under which reason, and what
 * the denominator was when it did.
 */
import { describe, expect, it } from 'vitest'
import {
  FailureCounters,
  OVERFLOW_REASON,
  failureRate,
  type FailureCounterSample,
} from '../failure-counters.js'

const at = (n: number): number => 1_700_000_000_000 + n

function find(
  samples: readonly FailureCounterSample[],
  deviceId: number,
  family: string,
): FailureCounterSample | undefined {
  return samples.find((s) => s.deviceId === deviceId && s.family === family)
}

describe('FailureCounters', () => {
  it('attributes a failure to the RIGHT camera under the RIGHT reason', () => {
    const counters = new FailureCounters()
    counters.note({ deviceId: 102, family: 'enrichment-crop', reason: 'native-miss' }, at(0))
    counters.note({ deviceId: 101, family: 'enrichment-crop', reason: 'native-miss' }, at(1))
    counters.note({ deviceId: 102, family: 'enrichment-crop', reason: 'native-miss' }, at(2))

    const samples = counters.snapshot(at(10))
    const dev102 = find(samples, 102, 'enrichment-crop')
    const dev101 = find(samples, 101, 'enrichment-crop')

    expect(dev102?.reasons).toEqual([{ reason: 'native-miss', count: 2 }])
    expect(dev101?.reasons).toEqual([{ reason: 'native-miss', count: 1 }])
    // The question is always "why is 102 worse than 101?" — a fleet total
    // cannot answer it, so the two must never share a bucket.
    expect(dev102?.attempts).toBe(2)
    expect(dev101?.attempts).toBe(1)
  })

  it('moves the DENOMINATOR on a success and nothing else', () => {
    const counters = new FailureCounters()
    for (let i = 0; i < 8; i += 1) {
      counters.note({ deviceId: 102, family: 'enrichment-crop' }, at(i))
    }
    counters.note({ deviceId: 102, family: 'enrichment-crop', reason: 'native-miss' }, at(9))

    const sample = find(counters.snapshot(at(10)), 102, 'enrichment-crop')
    expect(sample?.attempts).toBe(9)
    expect(sample?.succeeded).toBe(8)
    expect(sample?.reasons).toEqual([{ reason: 'native-miss', count: 1 }])
    // The number the operator actually reads. 1-in-9, not "1 miss".
    expect(failureRate(sample!)).toBeCloseTo(1 / 9, 10)
  })

  it('keeps the loss partition summing to attempts - succeeded', () => {
    const counters = new FailureCounters()
    counters.note({ deviceId: 102, family: 'capture-schedule' }, at(0))
    counters.note({ deviceId: 102, family: 'capture-schedule', reason: 'stale-drop' }, at(1))
    counters.note({ deviceId: 102, family: 'capture-schedule', reason: 'queue-overflow' }, at(2))
    counters.note({ deviceId: 102, family: 'capture-schedule', reason: 'stale-drop' }, at(3))

    const sample = find(counters.snapshot(at(4)), 102, 'capture-schedule')!
    const partition = sample.reasons.reduce((sum, r) => sum + r.count, 0)
    expect(partition).toBe(sample.attempts - sample.succeeded)
    // Ordered by weight so the dominant cause is the first thing read.
    expect(sample.reasons[0]).toEqual({ reason: 'stale-drop', count: 2 })
  })

  it('separates variants of one family so "which camera AND which model" is one read', () => {
    const counters = new FailureCounters()
    counters.note({ deviceId: 102, family: 'inference', variant: 'yolo', reason: 'timeout' }, at(0))
    counters.note({ deviceId: 102, family: 'inference', variant: 'clip', reason: 'timeout' }, at(1))
    counters.note({ deviceId: 102, family: 'inference', variant: 'clip' }, at(2))

    const samples = counters.snapshot(at(3)).filter((s) => s.family === 'inference')
    expect(samples).toHaveLength(2)
    const clip = samples.find((s) => s.variant === 'clip')!
    expect(clip.attempts).toBe(2)
    expect(clip.succeeded).toBe(1)
  })

  it('REFUSES an observation that cannot name its camera', () => {
    const counters = new FailureCounters()
    counters.note({ deviceId: 0, family: 'plate-ocr', reason: 'empty-read' }, at(0))
    counters.note({ deviceId: -1, family: 'plate-ocr', reason: 'empty-read' }, at(1))
    counters.note({ deviceId: 1.5, family: 'plate-ocr', reason: 'empty-read' }, at(2))
    // An unnamed per-camera count is indistinguishable from a shared one, and
    // would quietly turn one camera's failures into everybody's.
    expect(counters.snapshot(at(3))).toEqual([])
  })

  it('reads WITHOUT resetting, so two consumers cannot destroy each other', () => {
    const counters = new FailureCounters()
    counters.note({ deviceId: 102, family: 'inference', reason: 'timeout' }, at(0))

    const first = find(counters.snapshot(at(1)), 102, 'inference')
    const second = find(counters.snapshot(at(2)), 102, 'inference')
    expect(first?.attempts).toBe(1)
    expect(second?.attempts).toBe(1)
    // `sinceMs` is the incarnation marker and must survive a read: a consumer
    // differencing two samples drops the interval only when the counter itself
    // restarted.
    expect(second?.sinceMs).toBe(at(0))
    expect(second?.atMs).toBe(at(2))
  })

  it('FOLDS reasons past the cap instead of dropping them', () => {
    const counters = new FailureCounters(1024, 2)
    counters.note({ deviceId: 102, family: 'plate-ocr', reason: 'a' }, at(0))
    counters.note({ deviceId: 102, family: 'plate-ocr', reason: 'b' }, at(1))
    counters.note({ deviceId: 102, family: 'plate-ocr', reason: 'c' }, at(2))
    counters.note({ deviceId: 102, family: 'plate-ocr', reason: 'd' }, at(3))

    const sample = find(counters.snapshot(at(4)), 102, 'plate-ocr')!
    expect(sample.reasons.find((r) => r.reason === OVERFLOW_REASON)?.count).toBe(2)
    // Dropping them would make the partition stop equalling the loss, and the
    // ratio the whole surface publishes would silently stop adding up.
    expect(sample.reasons.reduce((sum, r) => sum + r.count, 0)).toBe(
      sample.attempts - sample.succeeded,
    )
  })

  it('refuses new keys past the cap and SAYS how many it refused', () => {
    const counters = new FailureCounters(2, 16)
    counters.note({ deviceId: 1, family: 'inference' }, at(0))
    counters.note({ deviceId: 2, family: 'inference' }, at(1))
    counters.note({ deviceId: 3, family: 'inference' }, at(2))
    counters.note({ deviceId: 4, family: 'inference' }, at(3))

    expect(counters.size).toBe(2)
    // A bound that bit is a fact about the deployment. Hiding it would
    // under-report a fleet exactly when the fleet got big enough to matter.
    expect(counters.keysRefused).toBe(2)
  })

  it('has no failure rate for a camera nobody asked anything of', () => {
    // Reporting 0 would say the camera was perfect; it was never tried.
    expect(
      failureRate({
        deviceId: 102,
        family: 'inference',
        sinceMs: at(0),
        atMs: at(1),
        attempts: 0,
        succeeded: 0,
        reasons: [],
      }),
    ).toBeNull()
  })
})
