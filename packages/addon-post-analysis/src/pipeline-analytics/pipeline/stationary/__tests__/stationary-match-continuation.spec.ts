/**
 * A weak hold may CONTINUE a track; only a strong read is the parked object
 * (D410). Every box is a measured device-102 box — see the fixture.
 */
import { describe, expect, it } from 'vitest'
import {
  DNRG309_PARTIAL_READ,
  ENTRIES_102,
  ENTRY_DNRG309,
  ENTRY_SILVER,
  PASS_AFTER_LAST_BOX,
  TRACK_1A453F8C,
  TRACK_5E3F1F75_LAST,
  TRACK_5E3F1F75_NEXT,
  TRACK_63C6E83D_LAST,
  TRACK_63C6E83D_NEXT,
} from '../../../__tests__/fixtures/device-102-parked-pass.js'
import { iou, partitionDetectionsAgainstRegistry } from '../stationary-match.js'
import { DEFAULT_MATCH_CONFIG } from '../stationary-types.js'

const NOW = 1788897762657

function partition(
  detections: readonly { bbox: { x: number; y: number; w: number; h: number } }[],
) {
  return partitionDetectionsAgainstRegistry({
    entries: ENTRIES_102,
    detections: detections.map((d) => ({ bbox: d.bbox, className: 'vehicle' })),
    config: DEFAULT_MATCH_CONFIG,
    now: NOW,
  })
}

const LAST_STORED = TRACK_1A453F8C[TRACK_1A453F8C.length - 1]!

describe('partitionDetectionsAgainstRegistry — the 102 pass: strong reads are dropped, weak holds may continue (D410)', () => {
  it('the SUV’s last stored box is released beside a detected parked car — the frame the track still updated', () => {
    // 20:02:42.479, `detections: 3, tracked: 1` in the log: parked car read
    // strongly, the SUV at IoU 0.129 with its centroid outside.
    expect(iou(LAST_STORED.bbox, ENTRY_DNRG309.bbox)).toBeCloseTo(0.129, 2)
    const res = partition([{ bbox: ENTRY_DNRG309.bbox }, { bbox: LAST_STORED.bbox }])
    expect([...res.suppressedIndices]).toEqual([0])
    expect(res.continuableIndices.size).toBe(0)
  })

  it('every box of the pass is HELD (it covers the parked car) and every one is CONTINUABLE', () => {
    for (const p of PASS_AFTER_LAST_BOX) {
      // The SUV occludes the parked car, so the detector has one vehicle box:
      // the entry’s best match, held by the swallow rule below `suppressIou`.
      expect(iou(p.bbox, ENTRY_DNRG309.bbox)).toBeLessThan(DEFAULT_MATCH_CONFIG.suppressIou)
      const alone = partition([{ bbox: p.bbox }])
      expect([...alone.suppressedIndices]).toEqual([0])
      expect([...alone.continuableIndices]).toEqual([0])
      // And when the parked car IS read too, the reach pass holds the SUV by
      // the same predicate — still continuable, never dropped.
      const both = partition([{ bbox: ENTRY_DNRG309.bbox }, { bbox: p.bbox }])
      expect([...both.suppressedIndices].toSorted()).toEqual([0, 1])
      expect([...both.continuableIndices]).toEqual([1])
      expect(both.reachSuppressedCount).toBe(1)
    }
  })

  it('a parked car’s OWN box is a strong read: suppressed and never continuable', () => {
    const res = partition([{ bbox: ENTRY_DNRG309.bbox }, { bbox: ENTRY_SILVER.bbox }])
    expect([...res.suppressedIndices].toSorted()).toEqual([0, 1])
    expect(res.continuableIndices.size).toBe(0)
    expect(res.confirmed.map((c) => c.strong)).toEqual([true, true])
  })

  it('the D275 leak signature (IoU 0.55, centroid inside) stays suppressed — continuable is not released', () => {
    expect(iou(DNRG309_PARTIAL_READ, ENTRY_DNRG309.bbox)).toBeCloseTo(0.55, 2)
    const res = partition([{ bbox: DNRG309_PARTIAL_READ }])
    expect([...res.suppressedIndices]).toEqual([0])
    // Weak, so the tracker may use it to continue a confirmed track — and the
    // tracker refuses it a birth (sort-tracker-stationary-continuation.spec).
    expect([...res.continuableIndices]).toEqual([0])
  })

  it('a DEPARTING read (centroid outside, IoU ≥ wakeAssocIou) is held weakly — and continuable', () => {
    // 5e3f1f75’s next box: IoU 0.147 with DNRG309, centroid left of the spot,
    // the parked car’s centroid just outside the box (no swallow). Alone it is
    // the entry’s best match and reads as a departure: armed, suppressed.
    expect(iou(TRACK_5E3F1F75_NEXT, ENTRY_DNRG309.bbox)).toBeCloseTo(0.147, 2)
    const res = partition([{ bbox: TRACK_5E3F1F75_NEXT }])
    expect(res.strikeChanges.map((s) => s.reason)).toEqual(['armed'])
    expect([...res.suppressedIndices]).toEqual([0])
    expect([...res.continuableIndices]).toEqual([0])
  })

  it('the two other operator tracks end on the same geometry', () => {
    for (const [last, next] of [
      [TRACK_63C6E83D_LAST, TRACK_63C6E83D_NEXT],
      [TRACK_5E3F1F75_LAST, TRACK_5E3F1F75_NEXT],
    ] as const) {
      // Last stored box: below the association floor — released, and stored.
      expect(iou(last, ENTRY_DNRG309.bbox)).toBeLessThan(DEFAULT_MATCH_CONFIG.wakeAssocIou)
      expect(partition([{ bbox: last }]).suppressedIndices.size).toBe(0)
      // The next box overlaps the spot: held, weakly.
      const res = partition([{ bbox: next }])
      expect([...res.suppressedIndices]).toEqual([0])
      expect([...res.continuableIndices]).toEqual([0])
    }
  })
})
