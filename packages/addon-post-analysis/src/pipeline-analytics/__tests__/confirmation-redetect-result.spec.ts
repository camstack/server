/**
 * The re-detect answer the gate judges (D922): kept boxes decide, and the
 * boxes the detector's own floor refused ride along — marked — so a
 * suppression can carry the score the crop really held.
 */
import { describe, expect, it } from 'vitest'
import { toConfirmationDetections } from '../confirmation-redetect-result.js'

describe('toConfirmationDetections', () => {
  it('carries a below-threshold discard as a floor-refused detection with its score', () => {
    const out = toConfirmationDetections({
      width: 200,
      height: 100,
      detections: [],
      discarded: [{ macroClass: 'person', score: 0.55, reason: 'below-threshold' }],
    })
    expect(out).toEqual([{ macroClass: 'person', score: 0.55, refusedByDetectorFloor: true }])
  })

  it('leaves out discards that are not a score the gate could use', () => {
    const out = toConfirmationDetections({
      detections: [],
      discarded: [
        { macroClass: 'person', score: 0.9, reason: 'class-filter' },
        { macroClass: 'vehicle', score: 0.3, reason: 'full-frame-guard' },
      ],
    })
    expect(out).toEqual([])
  })

  it('normalises a kept box to the crop and never marks it refused', () => {
    const out = toConfirmationDetections({
      width: 200,
      height: 100,
      detections: [
        { macroClass: 'person', score: 0.8, bbox: { x: 20, y: 10, width: 100, height: 50 } },
      ],
    })
    expect(out).toEqual([
      { macroClass: 'person', score: 0.8, bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
    ])
  })

  it('answers null when the run carried no detections array', () => {
    expect(toConfirmationDetections(null)).toBeNull()
    expect(toConfirmationDetections({ width: 10 })).toBeNull()
  })
})
