/**
 * Follow-up 102: synthetic parking-camera scenes (see `scenes/followup-102-scenes.ts`).
 *
 * What each scene pins (disarms run each alone, restored):
 *  - F2 WITHDRAWN (fix round 1): (A) pins its accepted 2 ids; (S) guards the band the
 *    reach on the larger box opened — RED with it for every vehicle arc, and RED with
 *    the narrowed variant (approach terms) on `follower` inside half a second;
 *  - F1 is pinned in `out-of-order-frame.spec.ts` (with F2 withdrawn, scene (A) is two
 *    ids with or without the out-of-order frame).
 *
 * Mix-up guards (fix round 1, F3 withdrawn): (M1), (M2), (M3) and (C) assert no
 * id covers two subjects. With F3's L1 exemption (an unconfirmed competitor
 * raises no doubt against a confirmed owner) (M1) and (M2) went RED (a mix);
 * with the L2 "dissolved doubt" link instead, (M3) went RED. (C) pins the
 * accepted extra id. (B) guards class gating only: a person and a vehicle never
 * gate each other, so nothing F1–F3 touch can turn it red.
 */
import { describe, expect, it } from 'vitest'
import {
  confirmedCarThenSecondCar102,
  confirmedCarThenStub617,
  passerOccludesParkedCar102,
  personBesideParkedCar102,
  type SequenceHeading,
  secondCarHidesFirst102,
  turningCar102,
  twoCarsInSequence617,
} from './scenes/followup-102-scenes.js'
import { runScene, type SceneOutcome } from './scenes/run-scene.js'

function noIdSpansTwoSubjects(o: SceneOutcome): void {
  for (const [id, truths] of o.truthsByFinalId)
    expect([id, [...truths]]).toEqual([id, [...truths].slice(0, 1)])
}

function idsOf(o: SceneOutcome, truth: string): number | undefined {
  return o.finalIdsByTruth.get(truth)?.size
}

describe('102 follow-up scenes', () => {
  it('(A) a car turning in toward the camera — 550 px, area ×2.2 — is two ids, never a mix (F2 withdrawn)', () => {
    for (const outOfOrder of [false, true]) {
      const o = runScene(turningCar102({ outOfOrder }))
      noIdSpansTwoSubjects(o)
      expect([outOfOrder, idsOf(o, 'car'), o.fusions.length]).toEqual([outOfOrder, 2, 0])
    }
  })

  it('(B) class-gating guard: a person walking along a parked car — one id each, never mixed', () => {
    const o = runScene(personBesideParkedCar102())
    noIdSpansTwoSubjects(o)
    expect([idsOf(o, 'parked'), idsOf(o, 'walker')]).toEqual([1, 1])
  })

  it('(C) a confirmed car followed by a 1- or 2-hit flicker stub: never a mix — the extra id is accepted (F3 withdrawn)', () => {
    for (const stubHits of [1, 2] as const) {
      const o = runScene(confirmedCarThenStub617({ stubHits }))
      noIdSpansTwoSubjects(o)
      // Indistinguishable from (M3) without appearance: the car's continuation
      // is a contested piece and stays its own id.
      expect([stubHits, idsOf(o, 'car')]).toEqual([stubHits, 2])
    }
  })

  it('(M2) the same geometry with a REAL second car: no id ever covers both cars', () => {
    for (const stubHits of [1, 2] as const) {
      const o = runScene(confirmedCarThenSecondCar102({ stubHits }))
      noIdSpansTwoSubjects(o)
    }
  })

  it('(M1) a passing car occluding a parked car: no id ever covers both', () => {
    for (const [passerHits, x1] of [
      // F3's guard: RED with the withdrawn L1 exemption (a mix).
      [1, 860],
      // Plain regression guards: green with and without F3 (re-review LOW-1).
      [2, 870],
      [2, 880],
    ] as const) {
      const o = runScene(passerOccludesParkedCar102({ passerHits, x1 }))
      noIdSpansTwoSubjects(o)
    }
  })

  // Known, pre-existing band (predates F3; re-review LOW-1; the private session log
  // 2026-10-01 tracker-102): a 1-hit passer whose first occluded box lands at
  // x1 ≥ 900 is cheaper for the parked car's tracklet by more than RIVAL_MARGIN,
  // so the solver gives it the parked id with no doubt raised — one id covers
  // both cars (runScene: 3 ids, mixed 1, with and without F3).
  it.todo(
    '(M1) a 1-hit passer at x1 ≥ 900 takes the parked car’s id — the pre-existing mix-up band',
  )

  it('(M3) a second car stopping in front of the first, hiding it: no id ever covers both', () => {
    for (const stubHits of [1, 2] as const) {
      const o = runScene(secondCarHidesFirst102({ stubHits }))
      noIdSpansTwoSubjects(o)
    }
  })

  it('(S) two different cars in sequence, the second larger, 450–600 px on: never one id (F2 withdrawn)', () => {
    // The predecessor rule already fuses at ≤ 400 px (reach 424): not F2's band.
    const headings: readonly SequenceHeading[] = [
      'opposite',
      'oncoming',
      'behind',
      'parked',
      'follower',
    ]
    for (const heading of headings)
      for (const gapMs of [130, 1300])
        for (const distance of [450, 500, 550, 600]) {
          const o = runScene(twoCarsInSequence617({ distance, heading, gapMs }))
          expect([heading, gapMs, distance, o.fusions.length]).toEqual([
            heading,
            gapMs,
            distance,
            0,
          ])
          noIdSpansTwoSubjects(o)
        }
  })
})
