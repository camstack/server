/**
 * D683 Task 21 (fix round 1): rules the old tracker (`sort-tracker.ts`,
 * deleted here) pinned, that tracker v2 keeps — ported against
 * `TrackletTracker` before the deleted specs that pinned them went with the
 * module. Each `it` names the deleted spec and test it replaces.
 *
 *  - `sort-tracker-person-with-animal.spec.ts` — "at the bar and above, a
 *    coarse box of the other class is its own subject even in the same
 *    place" (D439): a confident cross-class box is never silently absorbed.
 *  - `sort-tracker-native-recovery-survives.spec.ts` — "births the animal
 *    when the coarse pass has lost the person it walks beside" (D377): a
 *    native-resolution measurement is exempt from both the cross-class flip
 *    read and the per-class score floor that would otherwise drop it.
 *  - `sort-tracker-spawn-refusal.spec.ts` — "reports the per-class score
 *    floor with the bar and the score" / "reports the person-over-animal
 *    dedup, naming the track it lost to" (D391): the refusal vocabulary
 *    carries the numbers the gate weighed, not just the reason string.
 *  - `sort-tracker-overhaul.spec.ts`'s W2 block — the per-class minimum
 *    bbox-area spawn floor (fix round 1, M1): a far-field tiny box never
 *    spawns, a normal-size one does, an already-live tracklet is never
 *    killed by a later shrink (spawn-only gate), and the gate is a no-op
 *    with no frame context.
 */
import type { BoundingBox, SpatialDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sequentialTrackIdMinter } from '../../track-id.js'
import type { SpawnRefusalFacts } from '../../tracker/spawn-refusal.js'
import { TrackletTracker } from '../tracklet-tracker.js'
import {
  DEFAULT_TRACKER_V2_CONFIG,
  type TrackerV2Config,
  type TrackerV2FrameContext,
} from '../types.js'

const CTX: TrackerV2FrameContext = { frameWidth: 3840, frameHeight: 2160 }
const box = (x: number, y = 100, w = 100, h = 200): BoundingBox => ({ x, y, w, h })
const det = (b: BoundingBox, cls = 'person', score = 0.9): SpatialDetection => ({
  class: cls,
  originalClass: cls,
  score,
  bbox: b,
})
const nativeDet = (
  b: BoundingBox,
  cls: string,
  score: number,
  nativeScore: number,
): SpatialDetection => ({
  class: cls,
  originalClass: cls,
  score,
  bbox: b,
  nativeRecovery: { score: nativeScore, cropSidePx: 720, viewPx: 640 },
})

function tracker(
  refusals: SpawnRefusalFacts[] = [],
  config: Partial<TrackerV2Config> = {},
): TrackletTracker {
  return new TrackletTracker(
    { ...DEFAULT_TRACKER_V2_CONFIG, ...config },
    sequentialTrackIdMinter(),
    { refusal: (f) => refusals.push(f) },
  )
}

/** Confirm a person tracklet over `minHits` (3) frames on a fixed box. */
function confirmPerson(tr: TrackletTracker, b: BoundingBox): number {
  let t = 0
  for (let i = 0; i < 3; i++) {
    tr.step([det(b)], t, CTX)
    t += 130
  }
  return t
}

describe('D439 — a confident cross-class box is its own subject, never absorbed', () => {
  it("at the bar and above, a coarse animal on the person's own box is its own subject, never absorbed", () => {
    const PERSON = box(1000, 800, 600, 1000)
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    const t = confirmPerson(tr, PERSON)

    // The confident (>= animalOverPersonMaxScore) animal box is the ONLY
    // detection this frame — on the person's own box, and the person is NOT
    // re-detected. This is the original test's exact shape (fix round 1, M2):
    // the port this replaces fed person+animal TOGETHER, which bound the
    // person trivially and left the animal no track to be absorbed INTO —
    // proving nothing about classRelation at all (it passed even with the
    // confidence bar removed).
    const out = tr.step([det(PERSON, 'animal', 0.7)], t, CTX)

    // Never bound to the person (classRelation forbids a confident cross-class
    // pairing): no absorption, and the person's own emission is unmatched.
    expect(refusals.map((r) => r.reason)).not.toContain('cross-class-absorbed')
    const personEmission = out.emissions.find((e) => e.tracklet.klass === 'person')
    expect(personEmission?.matched).toBe(false)
    // The animal is not refused either (nothing else to refuse it against,
    // since the person was not bound this frame to compete for the spot) — it
    // becomes a tracklet of its own.
    expect(
      tr
        .liveTracklets()
        .map((l) => l.klass)
        .toSorted(),
    ).toEqual(['animal', 'person'])
  })
})

describe('D377 — a native-resolution measurement is not a coarse misread', () => {
  it('births the animal when the coarse pass has lost the person it walks beside', () => {
    const PERSON = box(1000, 800, 600, 1000)
    const DOG = box(1350, 1500, 250, 250)
    const refusals: SpawnRefusalFacts[] = []
    // animalOverPersonMaxScore default 0.6, classMinScores.animal default 0.45:
    // a 0.3 score is below BOTH, and below is exactly the point — native
    // recovery is what survives it.
    const tr = tracker(refusals)
    confirmPerson(tr, PERSON)

    // The person is not re-detected this frame (the coarse pass lost it) —
    // only the native-recovered dog.
    const out = tr.step([nativeDet(DOG, 'animal', 0.3, 0.83)], 390, CTX)

    expect(refusals.map((r) => r.reason)).not.toContain('score-floor')
    // The person (already confirmed) emits unmatched/coasting; the dog is a
    // brand-new tracklet, not yet past minHits, so it is not emitted YET — but
    // it exists, which is the whole point: it was born, not folded away.
    expect(out.emissions.map((e) => [e.tracklet.klass, e.matched])).toEqual([['person', false]])
    expect(
      tr
        .liveTracklets()
        .map((l) => l.klass)
        .toSorted(),
    ).toEqual(['animal', 'person'])
  })
})

describe('D391 — the refusal vocabulary carries the numbers the gate weighed', () => {
  it('reports the per-class score floor with the bar and the score', () => {
    const DOG = box(1350, 1500, 250, 250)
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)

    tr.step([det(DOG, 'animal', 0.3)], 0, CTX)

    const record = refusals.find((r) => r.reason === 'score-floor')
    expect(record).toBeDefined()
    expect(record?.detClass).toBe('animal')
    expect(record?.threshold).toBe(DEFAULT_TRACKER_V2_CONFIG.classMinScores['animal'])
    expect(record?.measured).toBe(0.3)
  })

  it('reports the person-over-animal dedup, naming the track it lost to', () => {
    const PERSON = box(100, 100, 60, 160)
    /** Overlaps the person's box at IoU 0.2545 (>= animalOverPersonIou 0.2) —
     *  a dog on a lead at its owner's knee. */
    const DOG = box(120, 180, 60, 70)
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)

    tr.step([det(PERSON), det(DOG, 'animal', 0.5)], 0, CTX)

    const record = refusals.find((r) => r.reason === 'animal-over-person')
    expect(record).toBeDefined()
    expect(record?.againstTrackClass).toBe('person')
    expect(record?.detScore).toBe(0.5)
  })
})

describe('W2 — per-class minimum bbox-area spawn floor (fix round 1, M1)', () => {
  // Same geometry as the deleted sort-tracker-overhaul.spec.ts's W2 block,
  // where it fits tracklet-tracker.ts:432-435's live `area-floor` gate.
  // classSpawnAreaFracs.person (0.0005) and minSpawnAreaEnabled are
  // DEFAULT_TRACKER_V2_CONFIG's own defaults — no override needed.
  const FRAME: TrackerV2FrameContext = { frameWidth: 640, frameHeight: 360 } // area 230_400
  // 6×6 = 36 px ⇒ 0.00016 of frame (below the 0.0005 person floor).
  const TINY: BoundingBox = { x: 300, y: 180, w: 6, h: 6 }
  // 40×40 = 1600 px ⇒ 0.0069 of frame (well above the floor).
  const BIG: BoundingBox = { x: 100, y: 100, w: 40, h: 40 }

  it('a far-field tiny person box does NOT spawn a track', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)

    tr.step([det(TINY)], 0, FRAME)

    expect(tr.liveTracklets()).toHaveLength(0)
    expect(refusals.map((r) => r.reason)).toContain('area-floor')
  })

  it('a normal-size person box still spawns (floor is conservative)', () => {
    const tr = tracker()

    tr.step([det(BIG)], 0, FRAME)

    expect(tr.liveTracklets()).toHaveLength(1)
  })

  it('an ALREADY-tracked subject that shrinks below the floor still matches (spawns-only gate)', () => {
    // A box just above the floor (156 px ⇒ 0.00068), so it spawns; the second
    // box is both BELOW the floor (49 px ⇒ 0.00021) AND at high enough IoU
    // (0.314, same top-left corner, fully contained) to clear iouThreshold
    // (0.3) and bind through ordinary association — never reaching the spawn
    // gates at all. That is the whole point: the floor is a SPAWN gate, not a
    // continuation one.
    const ABOVE_FLOOR: BoundingBox = { x: 100, y: 100, w: 13, h: 12 }
    const SHRUNK: BoundingBox = { x: 100, y: 100, w: 7, h: 7 }
    const refusals: SpawnRefusalFacts[] = []
    // minHits: 1 so the first box confirms immediately and the second frame's
    // `emissions` (confirmed tracklets only) can prove the match directly.
    const tr = tracker(refusals, { minHits: 1 })
    const first = tr.step([det(ABOVE_FLOOR)], 0, FRAME)
    const id = first.emissions[0]?.tracklet.id
    expect(id).toBeDefined()

    const out = tr.step([det(SHRUNK)], 100, FRAME)

    expect(refusals.map((r) => r.reason)).not.toContain('area-floor')
    expect(tr.liveTracklets().map((l) => l.id)).toEqual([id])
    expect(out.emissions.find((e) => e.tracklet.id === id)?.matched).toBe(true)
  })

  it('with no frame context the area gate is a no-op (tiny box spawns)', () => {
    const tr = tracker()

    tr.step([det(TINY)], 0, { frameWidth: 0, frameHeight: 0 })

    expect(tr.liveTracklets()).toHaveLength(1)
  })
})
