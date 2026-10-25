/**
 * L1's association (§3.2). The gates, the single cost, and the three doubt
 * tests that turn a would-be swap into a split.
 *
 * Disarms (each alone, restored):
 *  - `SWAP_MARGIN` → 0: "two subjects overlapping both predictions are doubt" fails;
 *  - drop the cohort check: "a cohort does not split again while unconfirmed" fails;
 *  - ignore `appearanceResolvesAmbiguity` (always resolve): "uncalibrated
 *    appearance resolves nothing" fails;
 *  - drop the double-fire exclusion: "a double fire is not a rival" fails;
 *  - drop the competitor test: "two tracklets claiming one box is doubt" fails;
 *  - drop `inCohortDoubt` from the competitor loop: "cohort pieces in doubt competing for one merged box" fails;
 *  - drop `inCohortDoubt` from the rival loop: "a cohort piece in doubt with a rival box" fails;
 *  - gate a coasting tracklet on `max(prediction, last box)` again: "never reaches a box ahead on its prediction" fails;
 *  - drop `COAST_MAX_AREA_RATIO`: "a coasting tracklet does not re-bind a box of another size" fails.
 *
 * Fix round 1 (the task-4 review's H1, M1, L3, L4):
 *  - in `auditAssignedPair`, return when EITHER crossed edge is forbidden (the pre-fix
 *    swap test): both "… silently (fix round 1, H1)" tests fail;
 *  - gate a coasting tracklet at 0.1 (the old rescue overlap): "a new subject beside a
 *    coasting tracklet spawns" fails;
 *  - make `canRival` return true: both L3 tests fail;
 *  - exempt the competitor loop on `inCohortDoubt(tp)` alone, as the rival loop does:
 *    "a stranger competing with a cohort piece in doubt splits it" fails;
 *  - `RIVAL_MARGIN` → 0: "two tracklets at exactly equal cost for one box is doubt" fails
 *    (with every other margin test — the rival fixture is equal-cost too).
 *
 * Fix round 2 (the re-review's M-A):
 *  - price a forbidden crossed edge at 0 instead of `1 − iouThreshold`: "a one-sided
 *    crossing that is clearly worse is not doubt" and "… judged by the swap sum …" fail.
 *
 * Fix round 3 (re-review 2's M-D, M-E):
 *  - price a forbidden crossed edge at the ceiling only, ignoring the free box: "… prices the
 *    forbidden edge at the tracklet's free box" fails;
 *  - forbidden-edge ceiling → 0.5, 0.95 or 1.0: "the forbidden-edge price is the gate ceiling 0.7" fails.
 *
 * Round 4 (D683 task 5, operator 2026-09-30): the presence tracklet mode and the
 * "nobody gets it" contest band are removed — a stationary subject belongs to the
 * occupancy registry, never to a long-lived track. A still subject and a passer-by
 * are now two moving tracklets, judged by the same three doubt tests as any other
 * pair. Disarm: drop the competitor test (same disarm as above) turns "a still
 * subject and a passer-by are two moving tracklets under the ordinary doubt tests
 * (round 4)" RED too.
 *
 * Task-6 review H2: give a COASTING owner `RIVAL_MARGIN` again in the competitor
 * loop: "a coasting owner never wins a box by margin over a gated active
 * tracklet" fails (and the tracker's double-crossing scene with it).
 */
import { APPEARANCE_BIN_COUNT, type AppearanceDescriptor, type BoundingBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { foldAppearance } from '../appearance.js'
import {
  type AssocConfig,
  type AssocDetection,
  type Association,
  type AssocTracklet,
  associate,
} from '../association.js'

const CFG: AssocConfig = {
  iouThreshold: 0.3,
  classGating: true,
  classGroupAssoc: true,
  animalOverPersonMaxScore: 0.6,
  dedupSpawnIou: 0.6,
  appearanceResolvesAmbiguity: false,
}
const CALIBRATED: AssocConfig = { ...CFG, appearanceResolvesAmbiguity: true }

const box = (x: number, y = 100, w = 100, h = 200): BoundingBox => ({ x, y, w, h })

function desc(even: boolean): AppearanceDescriptor {
  return {
    version: 1,
    bins: Array.from({ length: APPEARANCE_BIN_COUNT }, (_, i) => ((i % 2 === 0) === even ? 9 : 0)),
    gray: false,
  }
}

function trk(id: string, b: BoundingBox, over: Partial<AssocTracklet> = {}): AssocTracklet {
  return {
    id,
    klass: 'person',
    mode: 'active',
    confirmed: true,
    inDoubt: false,
    cohort: null,
    lastBox: b,
    predicted: b,
    appearance: null,
    ...over,
  }
}

function det(b: BoundingBox, over: Partial<AssocDetection> = {}): AssocDetection {
  return {
    klass: 'person',
    score: 0.9,
    bbox: b,
    nativeRecovery: false,
    continuationOnly: false,
    ...over,
  }
}

describe('associate', () => {
  it('pairs two separated subjects with their own boxes, no doubt', () => {
    const r = associate(
      [trk('a', box(100)), trk('b', box(600))],
      [det(box(610)), det(box(105))],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => [p.tracklet, p.detection])).toEqual([
      [0, 1],
      [1, 0],
    ])
  })

  it('two subjects overlapping both predictions are doubt (the 101 door)', () => {
    const r = associate(
      [trk('a', box(100)), trk('b', box(140))],
      [det(box(120)), det(box(125))],
      CFG,
    )
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tracklets).toEqual([0, 1])
    expect(r.ambiguous[0]?.detections).toEqual([0, 1])
    expect(r.ambiguous[0]?.tests).toEqual(['swap'])
  })

  it('uncalibrated appearance resolves nothing', () => {
    const r = associate(
      [
        trk('a', box(100), { appearance: foldAppearance(null, desc(true)) }),
        trk('b', box(140), { appearance: foldAppearance(null, desc(false)) }),
      ],
      [det(box(120), { appearance: desc(true) }), det(box(125), { appearance: desc(false) })],
      CFG,
    )
    expect(r.ambiguous).toHaveLength(1)
  })

  it('calibrated, distinct appearance resolves the swap', () => {
    const r = associate(
      [
        trk('a', box(100), { appearance: foldAppearance(null, desc(true)) }),
        trk('b', box(140), { appearance: foldAppearance(null, desc(false)) }),
      ],
      [det(box(120), { appearance: desc(true) }), det(box(125), { appearance: desc(false) })],
      CALIBRATED,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => [p.tracklet, p.detection])).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('a cohort does not split again while unconfirmed; its pairs are contested', () => {
    const r = associate(
      [
        trk('a', box(100), { cohort: 'c1', confirmed: false }),
        trk('b', box(140), { cohort: 'c1', confirmed: false }),
      ],
      [det(box(120)), det(box(125))],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => p.contested)).toEqual([true, true])
  })

  it('cohort pieces in doubt competing for one merged box are contested, not re-split (review 2 M1)', () => {
    // Two hugging people read as ONE box: both pieces gate it within the margin.
    const r = associate(
      [
        trk('a', box(100), { cohort: 'c1', inDoubt: true }),
        trk('b', box(104), { cohort: 'c1', inDoubt: true }),
      ],
      [det(box(102))],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => p.contested)).toEqual([true])
  })

  it('a cohort piece in doubt with a rival box is contested, not re-split (review 2 M1)', () => {
    const r = associate(
      [trk('a', box(100), { cohort: 'c1', inDoubt: true })],
      [det(box(115)), det(box(85))],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => p.contested)).toEqual([true])
  })

  it('a coasting tracklet never reaches a box ahead on its prediction (review 2 M3)', () => {
    const t = trk('a', box(100), { mode: 'coasting', predicted: box(250) })
    expect(associate([t], [det(box(250))], CFG).pairs).toEqual([])
  })

  it('a confirmed cohort splits again on new doubt', () => {
    const r = associate(
      [trk('a', box(100), { cohort: 'c1' }), trk('b', box(140), { cohort: 'c1' })],
      [det(box(120)), det(box(125))],
      CFG,
    )
    expect(r.ambiguous).toHaveLength(1)
  })

  it('a second box nearly as good as the chosen one is doubt (rival)', () => {
    // 115 and 85 around a box at 100: IoU 0.739 each, 0.538 with each other (< dedupSpawnIou).
    const r = associate([trk('a', box(100))], [det(box(115)), det(box(85))], CFG)
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['rival'])
  })

  it('a double fire is not a rival: it is reported for a dedup refusal', () => {
    // 102 and 104 overlap each other at 0.96: one subject read twice.
    const r = associate([trk('a', box(100))], [det(box(102)), det(box(104))], CFG)
    expect(r.ambiguous).toEqual([])
    expect(r.pairs).toHaveLength(1)
    expect(r.doubleFires).toHaveLength(1)
  })

  it('two tracklets claiming one box is doubt (competitor)', () => {
    // a at 100 and b (coasting, same spot) both gate the box at 102 almost equally.
    const r = associate(
      [trk('a', box(100)), trk('b', box(101), { mode: 'coasting' })],
      [det(box(102))],
      CFG,
    )
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
  })

  it('a weak animal read may bind a person on the prediction; a confident one may not (D439)', () => {
    const person = trk('a', box(100))
    expect(
      associate([person], [det(box(105), { klass: 'animal', score: 0.5 })], CFG).pairs,
    ).toHaveLength(1)
    expect(
      associate([person], [det(box(105), { klass: 'animal', score: 0.7 })], CFG).pairs,
    ).toEqual([])
  })

  it('a continuation-only box never binds an unconfirmed tracklet (D410)', () => {
    expect(
      associate(
        [trk('a', box(100), { confirmed: false })],
        [det(box(105), { continuationOnly: true })],
        CFG,
      ).pairs,
    ).toEqual([])
  })

  it('a coasting tracklet re-binds on the normal gate with its last box', () => {
    // 100 → 140: IoU 0.429 ≥ iouThreshold, against the last box (the prediction is far ahead).
    const t = trk('a', box(100), { mode: 'coasting', predicted: box(400) })
    expect(associate([t], [det(box(140))], CFG).pairs).toHaveLength(1)
  })

  it('a new subject beside a coasting tracklet spawns: no rescue overlap (fix round 1, M1)', () => {
    // Last box at 200, a new person at 260: IoU 0.25 — under the normal gate, over the old 0.1 rescue.
    const t = trk('a', box(200), { mode: 'coasting' })
    const r = associate([t], [det(box(260))], CFG)
    expect(r.pairs).toEqual([])
    expect(r.ambiguous).toEqual([])
  })

  it('an assignment never beats a strictly better gated box silently (fix round 1, H1)', () => {
    // A sits exactly on 190 (prediction) and reaches 80 only through its lagging last box
    // (0.571); B reaches 190 at 0.4 and not 80 at all. The solver maximises the match count,
    // so it hands A the box at 80 — and the crossed edge B→80 is forbidden, so the swap test
    // never looks. A strictly prefers 190 (−0.571), and A is a better claimant of 190 than B (−0.4).
    const r = associate(
      [trk('a', box(120), { predicted: box(190) }), trk('b', box(215), { predicted: box(230) })],
      [det(box(190)), det(box(80))],
      CFG,
    )
    expect(r.pairs).toEqual([])
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]?.tracklets).toEqual([0, 1])
    expect(r.ambiguous[0]?.detections).toEqual([0, 1])
    // Swap sum with the forbidden B→80 priced at the gate ceiling 0.7: 0 + 0.7 − (0.571 + 0.4) = −0.271.
    expect(r.ambiguous[0]?.tests).toEqual(['swap'])
  })

  it('a coasting tracklet never takes a box an active one sits on, silently (fix round 1, H1)', () => {
    // A active: last 150, prediction 190. B coasting, last box 200. A→190 costs 0, A→100 0.667;
    // B→190 0.182 and B cannot reach 100. The solver gives B the box A sits on.
    const r = associate(
      [
        trk('a', box(150), { predicted: box(190) }),
        trk('b', box(200), { mode: 'coasting', predicted: box(100) }),
      ],
      [det(box(190)), det(box(100))],
      CFG,
    )
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tracklets).toEqual([0, 1])
    expect(r.ambiguous[0]?.detections).toEqual([0, 1])
  })

  it('a one-sided crossing that is clearly worse is not doubt (fix round 1, H1)', () => {
    // A sits on 100 and reaches B's box at 133 at 0.496; B holds 133 at 0.374 and cannot reach
    // 100 (IoU 0.282). Swap sum, forbidden edge at 0.7: 0.496 + 0.7 − 0.374 = 0.822 ≥ 0.2.
    const r = associate(
      [trk('a', box(100)), trk('b', box(156))],
      [det(box(100)), det(box(133))],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => [p.tracklet, p.detection])).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('a one-sided crossing is judged by the swap sum: more reach never removes doubt (fix round 2, M-A)', () => {
    // A sits on 100 (0) and reaches 133 at 0.496; B (last 200, prediction 162) holds 133 at 0.45
    // and cannot reach 100. Sum 0.496 + 0.7 − 0.45 = 0.746 ≥ 0.2: both stay pairs — as they do
    // when B's last box at 60 lets it reach 100 at 0.571 (a real swap sum of 0.617).
    const dets = [det(box(100)), det(box(133))]
    const weak = associate(
      [trk('a', box(100)), trk('b', box(200), { predicted: box(162) })],
      dets,
      CFG,
    )
    const reaching = associate(
      [trk('a', box(100)), trk('b', box(60), { predicted: box(162) })],
      dets,
      CFG,
    )
    for (const r of [weak, reaching]) {
      expect(r.ambiguous).toEqual([])
      expect(r.pairs.map((p) => [p.tracklet, p.detection])).toEqual([
        [0, 0],
        [1, 1],
      ])
    }
  })

  it("a one-sided crossing prices the forbidden edge at the tracklet's free box (fix round 3, M-D)", () => {
    // g = [[X, .158, .458], [.5, .282, X]]: the solver picks t0→d1, t1→d0 (0.658); t1 prefers
    // t0's box, and t0 has a free box d2 at 0.458. Priced at 0.458, not 0.7: 0.458 + 0.282 − 0.658
    // = 0.082 < 0.2 — doubt (the alternative t0→d2, t1→d1 costs only 0.082 more).
    const r = associate(
      [trk('t0', box(0)), trk('t1', box(-25))],
      [det(box(-58.3)), det(box(-8.6)), det(box(29.7))],
      CFG,
    )
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tracklets).toEqual([0, 1])
    expect(r.ambiguous[0]?.tests).toEqual(['swap'])
  })

  it('the forbidden-edge price is the gate ceiling 0.7, pinned from both sides (fix round 3, M-E)', () => {
    // A sits on 0 (cost 0) and reaches B's box at cost a; B holds it at 0.69 and cannot reach 0.
    // Sum = a + 0.7 − 0.69. B's prediction: 52.672 past its box (IoU 0.31).
    const scene = (bx: number): Association =>
      associate([trk('a', box(0)), trk('b', box(bx + 52.672))], [det(box(0)), det(box(bx))], CFG)
    // a = 0.20 (IoU 0.8): sum 0.21 — a pair (a price of 0.5 would make it doubt).
    expect(scene(11.111).ambiguous).toEqual([])
    // a = 0.18 (IoU 0.82): sum 0.19 — doubt (a price of 0.95 or 1.0 would make it a pair).
    expect(scene(9.89).ambiguous).toHaveLength(1)
  })

  it('a continuation-only box is never a rival (fix round 1, L3)', () => {
    // 112 (0.214) is chosen; 86 (0.246) is within the margin, 0.587 from 112 — but it can never spawn (D410).
    const r = associate(
      [trk('a', box(100))],
      [det(box(112)), det(box(86), { continuationOnly: true })],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => [p.tracklet, p.detection])).toEqual([[0, 0]])
  })

  it('a weak animal read is never a rival for a person (fix round 1, L3)', () => {
    const r = associate(
      [trk('a', box(100))],
      [det(box(112)), det(box(86), { klass: 'animal', score: 0.5 })],
      CFG,
    )
    expect(r.ambiguous).toEqual([])
    expect(r.pairs.map((p) => [p.tracklet, p.detection])).toEqual([[0, 0]])
  })

  it('a stranger competing with a cohort piece in doubt splits it (fix round 1, L4)', () => {
    // The piece sits on 101 (cost 0); a stranger with no cohort reaches it at 0.030.
    const r = associate(
      [trk('a', box(101), { cohort: 'c1', inDoubt: true }), trk('b', box(104))],
      [det(box(101))],
      CFG,
    )
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
  })

  it('two tracklets at exactly equal cost for one box is doubt (fix round 1, L4)', () => {
    // 100 and 104 around a box at 102: 0.0198 each.
    const r = associate([trk('a', box(100)), trk('b', box(104))], [det(box(102))], CFG)
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
  })

  it('a coasting tracklet does not re-bind a box of another size (D678 bar)', () => {
    const t = trk('a', box(100, 100, 100, 200), { mode: 'coasting', predicted: box(400) })
    // Overlaps the last box at IoU 0.333 (≥ iouThreshold, so only the size bar refuses it) but is 3× its area.
    expect(associate([t], [det({ x: 100, y: 100, w: 300, h: 200 })], CFG).pairs).toEqual([])
  })

  it('a still subject and a passer-by are two moving tracklets under the ordinary doubt tests (round 4)', () => {
    // 103's seat, and a walker whose prediction lands on it (IoU 0.95): one
    // box, two claimants within RIVAL_MARGIN. No presence stage arbitrates any
    // more — doubt splits them (spec §3.2, Q3: extra ids, never a mix-up).
    const SEAT_BOX = box(416, 1112, 1014, 565)
    const seat = trk('seat', SEAT_BOX)
    const walker = trk('walker', box(442, 1112, 1014, 565))
    const r = associate([seat, walker], [det(SEAT_BOX)], CFG)
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
    expect(Object.keys(r).sort()).toEqual(['ambiguous', 'doubleFires', 'pairs'])
  })

  it('a coasting owner never wins a box by margin over a gated active tracklet (task-6 review H2)', () => {
    // The double crossing at 780 ms: b coasts on its stale box at 410, a is active
    // at 425 with its prediction at 470 (it turned back). The box at 380 costs b
    // 0.46 and a 0.62 — 0.16 apart, past RIVAL_MARGIN — and it is A's box.
    const r = associate(
      [trk('a', box(425), { predicted: box(470) }), trk('b', box(410), { mode: 'coasting' })],
      [det(box(380))],
      CFG,
    )
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
  })
})
