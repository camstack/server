import { describe, expect, it } from 'vitest'
import { ALL_STEPS } from '../step-definitions'

/**
 * A plate is read REPEATEDLY, not once.
 *
 * `trigger: 'once'` means a non-null result is TERMINAL — the scheduler never
 * re-runs the chain (`detail-scheduler.ts:172-180`). For a plate that is the
 * wrong contract: the FIRST legible frame wins outright, whatever it says, and
 * `plate-vote.ts` — which exists to reconcile disagreeing reads — could only
 * ever be handed one. A vehicle crossing the frame offers a dozen better angles
 * after that first read, and every one of them was discarded.
 *
 * Measured on the live hub, 24 h: 40 vehicle tracks on camera 102 ended with no
 * plate at all.
 *
 * `maxPerTrack` stays: periodic must not mean unbounded on a car parked in
 * view. The bound is what keeps this affordable — one inference per interval
 * per live vehicle, on the node that owns it.
 */
const PLATE_STEPS = ['plate-detection', 'plate-ocr']

describe('the plate steps read a vehicle more than once', () => {
  it.each(PLATE_STEPS)('%s runs periodically, not once', (id) => {
    const step = ALL_STEPS.find((s) => s.id === id)
    expect(step, `${id} is not in the catalog`).toBeDefined()
    expect(step?.cadence?.trigger).toBe('periodic')
  })

  it.each(PLATE_STEPS)('%s still bounds itself per track', (id) => {
    const cadence = ALL_STEPS.find((s) => s.id === id)?.cadence
    expect(cadence?.maxPerTrack).toBeGreaterThan(0)
    expect(cadence?.minIntervalMs).toBeGreaterThan(0)
  })

  it('keeps the interval far enough apart to be a new view, not the same frame', () => {
    for (const id of PLATE_STEPS) {
      const cadence = ALL_STEPS.find((s) => s.id === id)?.cadence
      // The detail dispatcher ticks at 1 s; anything under that just queues.
      expect(cadence?.minIntervalMs).toBeGreaterThanOrEqual(1000)
    }
  })
})
