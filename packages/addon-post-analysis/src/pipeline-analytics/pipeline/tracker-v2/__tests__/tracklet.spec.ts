/**
 * The tracklet's own bookkeeping (§3.1).
 *
 * Disarms (each alone, restored):
 *  - in `observeLowScore`, also set `lastBox = box`: "a sub-floor box moves
 *    association state only" fails;
 *  - in `recordConfident`, assign `this.faceBearing = faceBearing` (not sticky):
 *    "becomes face-bearing once …" fails;
 *  - assign `firstFaceAt = t` (not `??=`): the same test fails (400, not 200).
 */
import type { SpatialDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MAX_PREDICTION_MS } from '../constants.js'
import { Tracklet } from '../tracklet.js'

function det(x: number, score = 0.9, cls = 'person'): SpatialDetection {
  return { class: cls, originalClass: cls, score, bbox: { x, y: 100, w: 50, h: 100 } }
}

function born(d: SpatialDetection, t: number): Tracklet {
  return new Tracklet({
    id: 't1',
    startedAt: t,
    det: d,
    lineage: { kind: 'birth' },
    cohort: null,
    faceBearing: false,
  })
}

describe('Tracklet', () => {
  it('measures velocity in px/ms and predicts over the elapsed time, capped', () => {
    const tr = born(det(100), 0)
    tr.observeConfident(det(200), 1000, false)
    expect(tr.velocity.vx).toBeCloseTo(0.1, 10)
    expect(tr.predicted(1500).x).toBeCloseTo(250, 6)
    expect(tr.predicted(1000 + 10 * MAX_PREDICTION_MS).x).toBeCloseTo(
      200 + 0.1 * MAX_PREDICTION_MS,
      6,
    )
  })

  it('a sub-floor box moves association state only', () => {
    const tr = born(det(100), 0)
    const hits = tr.hits
    tr.observeLowScore({ x: 130, y: 100, w: 50, h: 100 }, 500)
    expect(tr.lastBox.x).toBe(100)
    expect(tr.assocBox.x).toBe(130)
    expect(tr.hits).toBe(hits)
    expect(tr.heldByLowScore).toBe(true)
    expect(tr.lastSeenAt).toBe(0)
  })

  it('votes its reported class, keeping its association class', () => {
    const tr = born(det(100, 0.9), 0)
    tr.observeConfident(det(100, 0.5, 'animal'), 100, false)
    tr.observeConfident(det(100, 0.9), 200, false)
    expect(tr.klass).toBe('person')
    expect(tr.reportedClass(true, 0.5)).toBe('person')
  })

  it('becomes face-bearing once one of its boxes carried a face, and remembers when', () => {
    const tr = born(det(100), 0)
    tr.observeConfident(det(110), 100, false)
    expect([tr.faceBearing, tr.firstFaceAt]).toEqual([false, null])
    tr.observeConfident(det(120), 200, true)
    tr.observeConfident(det(130), 300, false)
    tr.observeConfident(det(140), 400, true)
    tr.observeConfident(det(150), 500, false)
    // Ends on a non-face observation after a face one: still face-bearing (sticky), and
    // firstFaceAt keeps the FIRST face's time, not the second (200, not 400).
    expect([tr.faceBearing, tr.firstFaceAt]).toEqual([true, 200])
  })

  it('ends once and keeps its end time', () => {
    const tr = born(det(100), 0)
    tr.end(900, 'missed')
    tr.end(1200, 'ambiguous')
    expect(tr.endedAt).toBe(900)
    expect(tr.endReason).toBe('missed')
  })
})
