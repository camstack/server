/**
 * Round 4 (operator 2026-09-30): a subject is a track while it moves; a
 * registry promotion closes it. A track that ever moved keeps its row and may
 * still be linked; one that never moved is D547's disposal, as today.
 *
 * "Moved" (fix round 1, review M1) is judged against a ROBUST reference — the
 * median centre of the first {@link PROMOTION_EARLY_BOXES} boxes, scaled by
 * their median short side — and only a SUSTAINED displacement counts:
 * {@link PROMOTION_SUSTAINED_BOXES} consecutive boxes beyond the span. One
 * truncated first box or one stray box is not a move.
 *
 * Disarms (each alone, restored):
 *  - make `planPromotion` always answer "moved": "a subject that was standing there from its first box is disposed" fails;
 *  - make it always answer "never moved": "a subject that walked to its seat keeps its track" fails;
 *  - measure the span against a constant 50 px instead of the short side: "the stillness span scales with the subject" fails;
 *  - `Math.min` → `Math.max` for the short side: "the span is the SHORT side" fails;
 *  - reference = the first box alone (no median): "a parked car whose first box was cut by the frame edge never moved" fails;
 *  - sustain = 1 box: "one stray box is not a move" fails;
 *  - judge the NET displacement (only the final boxes against the reference):
 *    "a subject that went away and came back moved" fails;
 *  - `>` → `>=`: "a displacement of exactly the span is not a move" fails;
 *  - drop the `isMeasurableBox` guard: "a box that cannot be measured changes
 *    nothing" fails (and `cascade-over-real-sqlite.spec.ts`, whose fixture
 *    position carries no box, throws inside `closeActive`).
 */
import type { BoundingBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { EMPTY_MOVED_PROBE, planPromotion, probeMoved, stepMovedProbe } from '../promotion-plan.js'

const box = (x: number, y: number, w: number, h: number): BoundingBox => ({ x, y, w, h })
// 103's four recorded seat variants: jitter, never a move.
const SEATS: readonly BoundingBox[] = [
  box(416, 1112, 1014, 565),
  box(416, 1097, 1014, 596),
  box(418, 1115, 1012, 558),
  box(418, 1099, 1012, 589),
]
const seats = (n: number): BoundingBox[] =>
  Array.from({ length: n }, (_, i) => SEATS[i % 4] ?? SEATS[0]!)
const repeat = (b: BoundingBox, n: number): BoundingBox[] => Array.from({ length: n }, () => b)

const MOVED = { dropReason: 'stationary', disposeLiveTrack: false } as const
const NEVER_MOVED = { dropReason: 'dropped', disposeLiveTrack: true } as const

describe('planPromotion', () => {
  it('a subject that was standing there from its first box is disposed (D547 unchanged)', () => {
    expect(planPromotion(seats(40))).toEqual(NEVER_MOVED)
  })

  it('a subject that walked to its seat keeps its track, and may be linked', () => {
    // 103: the operator walks in from the door, then sits.
    const walk = Array.from({ length: 10 }, (_, i) => box(2400 - i * 200, 1112, 1014, 565))
    expect(planPromotion([...walk, ...seats(30)])).toEqual(MOVED)
  })

  it('the stillness span scales with the subject', () => {
    // A 40×60 cat that drifts 30 px has moved (> 0.35 × 40 = 14 px); a
    // 1014×565 seat that drifts 30 px has not (< 0.35 × 565 ≈ 198 px).
    const cat = [...repeat(box(100, 100, 40, 60), 5), ...repeat(box(130, 100, 40, 60), 5)]
    const seat = [...repeat(box(416, 1112, 1014, 565), 5), ...repeat(box(446, 1112, 1014, 565), 5)]
    expect(planPromotion(cat)).toEqual(MOVED)
    expect(planPromotion(seat)).toEqual(NEVER_MOVED)
  })

  it('the span is the SHORT side', () => {
    // A 40×200 standing person who steps 30 px sideways moved: 30 > 0.35 × 40
    // = 14, though 30 < 0.35 × 200 = 70 would call it jitter.
    const person = [...repeat(box(500, 300, 40, 200), 5), ...repeat(box(530, 300, 40, 200), 5)]
    expect(planPromotion(person)).toEqual(MOVED)
  })

  it('a displacement of exactly the span is not a move', () => {
    // 40×40: span = 0.35 × 40 = 14 exactly.
    const path = [...repeat(box(1000, 500, 40, 40), 5), ...repeat(box(1014, 500, 40, 40), 5)]
    expect(planPromotion(path)).toEqual(NEVER_MOVED)
  })

  it('a parked car whose first box was cut by the frame edge never moved', () => {
    // Startup / night→day: the first box holds half the car (230×300 of
    // 460×300, its centre 115 px off the true one; 0.35 × 230 = 80.5 px).
    const cut = box(0, 400, 230, 300)
    const car = box(0, 400, 460, 300)
    expect(planPromotion([cut, ...repeat(car, 60)])).toEqual(NEVER_MOVED)
  })

  it('one stray box is not a move — nor two', () => {
    // A mis-bound or merged detection far from the seat, once, then twice.
    const stray = box(2400, 200, 1014, 565)
    expect(planPromotion([...seats(20), stray, ...seats(20)])).toEqual(NEVER_MOVED)
    expect(planPromotion([...seats(20), stray, stray, ...seats(20)])).toEqual(NEVER_MOVED)
  })

  it('a slow walker moved', () => {
    // 60×160 person, 2 px per box for 150 boxes (0.35 × 60 = 21 px), then stands.
    const walk = Array.from({ length: 150 }, (_, i) => box(200 + i * 2, 400, 60, 160))
    expect(planPromotion([...walk, ...repeat(box(500, 400, 60, 160), 40)])).toEqual(MOVED)
  })

  it('an approaching subject moved', () => {
    // Walks toward the camera: the box grows from 40×80 to 400×800 and its
    // centre comes down the frame; then it stops.
    const approach = Array.from({ length: 30 }, (_, i) => {
      const s = 1 + i * 0.31
      return box(900 - 20 * s, 100 + 12 * i, 40 * s, 80 * s)
    })
    const last = approach.at(-1) ?? box(0, 0, 1, 1)
    expect(planPromotion([...approach, ...repeat(last, 40)])).toEqual(MOVED)
  })

  it('a subject that went away and came back moved', () => {
    const home = box(300, 300, 60, 160)
    const away = box(900, 300, 60, 160)
    expect(planPromotion([...repeat(home, 10), ...repeat(away, 10), ...repeat(home, 40)])).toEqual(
      MOVED,
    )
  })

  it('a track with no boxes is disposed as one that never moved', () => {
    expect(planPromotion([])).toEqual(NEVER_MOVED)
  })
})

describe('the incremental probe', () => {
  it('answers exactly what the whole-path plan answers, box by box', () => {
    const walk = Array.from({ length: 10 }, (_, i) => box(2400 - i * 200, 1112, 1014, 565))
    const cases: readonly (readonly BoundingBox[])[] = [
      [],
      seats(3),
      seats(40),
      [...walk, ...seats(30)],
      [box(0, 400, 230, 300), ...repeat(box(0, 400, 460, 300), 60)],
      [...seats(20), box(2400, 200, 1014, 565), ...seats(20)],
    ]
    for (const path of cases) {
      let probe = EMPTY_MOVED_PROBE
      for (const b of path) probe = stepMovedProbe(probe, b)
      expect(probeMoved(probe)).toBe(planPromotion(path).dropReason === 'stationary')
    }
  })

  it('a box that cannot be measured changes nothing — the store folds this inside its persist', () => {
    const first = stepMovedProbe(EMPTY_MOVED_PROBE, box(0, 0, 10, 10))
    expect(stepMovedProbe(first, undefined)).toBe(first)
    expect(stepMovedProbe(first, box(Number.NaN, 0, 10, 10))).toBe(first)
  })

  it('never mutates the probe it was handed', () => {
    const first = stepMovedProbe(EMPTY_MOVED_PROBE, box(0, 0, 10, 10))
    const snapshot = JSON.stringify(first)
    stepMovedProbe(first, box(500, 500, 10, 10))
    expect(JSON.stringify(first)).toBe(snapshot)
    expect(EMPTY_MOVED_PROBE.early).toHaveLength(0)
  })
})
