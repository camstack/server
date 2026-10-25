/**
 * A notification must not lie about its own reason.
 *
 * Live audit, device 101, rule 'Persona su Uscio'
 * (`{attach:'best', frame:'full', gif:true}`), 54 fires over 18–21/08/2026 with
 * the delivered bytes read back off the artefact shelf and each frame's instant
 * read off the camera's own burnt-in clock: **9 of 54 (17%)** shipped a picture
 * in which the subject's box had ZERO overlap with the Uscio zone — the zone
 * whose condition fired the rule. The worst, 21/08 18:57:29
 * (track d0f63887…): the trigger frame put the person on the doorstep at 40.6%
 * Uscio overlap, the DELIVERED frame was 4.9 s later and put him 144 px away
 * from the zone (of a 640-wide detection frame) with the doorstep visibly
 * empty.
 *
 * It is not a delay: trigger→enqueue was 14 ms and enqueue→sent 7.7 s, both
 * nominal against every previous day. The still ladder simply has no opinion
 * about WHERE the subject was — it takes the track's best shot, a whole-track
 * quantity ranked for the gallery (D212/D213), and the best shot is routinely
 * a later frame (a failed native keyFrame capture retries and lands on
 * whatever is on screen then).
 *
 * The rule pinned here: the ladder runs over the frames that show the subject
 * inside the zone that fired the rule; only when NO frame does does it run over
 * all of them, exactly as before. The track's own best shot is untouched.
 */

import { describe, expect, it } from 'vitest'
import {
  type NcStillCandidate,
  type NcSubjectTrailPoint,
  selectTriggerZoneCandidates,
  TRAIL_MATCH_MAX_MS,
} from '../trigger-zone-still.js'

const T0 = 1_787_331_449_282

/** The real Uscio polygon on device 101, normalized, verbatim from `zones.listZones`. */
const USCIO: ReadonlyArray<{ readonly x: number; readonly y: number }> = [
  { x: 0.6232558139534884, y: 0.6101342734477763 },
  { x: 0.7519321559713237, y: 0.822337532462056 },
  { x: 0.5474733344990383, y: 1.0055884014393348 },
  { x: 0.23273882380369532, y: 0.9842819598779754 },
  { x: 0.12698024130092675, y: 0.48086383534094124 },
  { x: 0.5071341143556566, y: 0.3589414904217118 },
]

/** Normalize a 640×360 detection box the way the wiring does. */
function box(x: number, y: number, w: number, h: number): NcSubjectTrailPoint['bbox'] {
  return { x: x / 640, y: y / 360, w: w / 640, h: h / 360 }
}

/** The real trail of track d0f63887…, sampled at the instants that matter. */
const TRAIL: readonly NcSubjectTrailPoint[] = [
  // trigger — on the doorstep, 40.6% inside Uscio
  { timestamp: T0, bbox: box(303.1, 176.1, 286.3, 176.7) },
  // +5.0 s — up on the driveway, 0% inside Uscio (the frame that shipped)
  { timestamp: T0 + 5001, bbox: box(466.1, 35.7, 85.5, 80.5) },
  // +16.7 s — walking back, 18.8%
  { timestamp: T0 + 16677, bbox: box(257, 26, 135, 155) },
]

describe('selectTriggerZoneCandidates', () => {
  it('drops the frame whose subject was OUTSIDE the zone that fired the rule', () => {
    const candidates: readonly NcStillCandidate[] = [
      { kind: 'keyFrame', timestamp: T0 + 5001 },
      { kind: 'firstFrame', timestamp: T0 },
    ]
    const kept = selectTriggerZoneCandidates({
      candidates,
      trail: TRAIL,
      polygons: [USCIO],
      triggerAt: T0,
    })
    expect(kept.map((c) => c.kind)).toEqual(['firstFrame'])
  })

  it('keeps the ladder ORDER among the frames that qualify — it filters, it does not re-rank', () => {
    const candidates: readonly NcStillCandidate[] = [
      { kind: 'keyFrame', timestamp: T0 + 16677 },
      { kind: 'firstFrame', timestamp: T0 },
    ]
    const kept = selectTriggerZoneCandidates({
      candidates,
      trail: TRAIL,
      polygons: [USCIO],
      triggerAt: T0,
    })
    expect(kept.map((c) => c.kind)).toEqual(['keyFrame', 'firstFrame'])
  })

  it('returns EVERY candidate when none shows the subject in the zone — a real picture beats no picture', () => {
    const candidates: readonly NcStillCandidate[] = [{ kind: 'keyFrame', timestamp: T0 + 5001 }]
    const kept = selectTriggerZoneCandidates({
      candidates,
      trail: TRAIL,
      polygons: [USCIO],
      triggerAt: T0,
    })
    expect(kept.map((c) => c.kind)).toEqual(['keyFrame'])
  })

  it('returns every candidate when the trail is empty or no polygon resolved', () => {
    const candidates: readonly NcStillCandidate[] = [
      { kind: 'keyFrame', timestamp: T0 + 5001 },
      { kind: 'firstFrame', timestamp: T0 },
    ]
    expect(
      selectTriggerZoneCandidates({ candidates, trail: [], polygons: [USCIO], triggerAt: T0 }).map(
        (c) => c.kind,
      ),
    ).toEqual(['keyFrame', 'firstFrame'])
    expect(
      selectTriggerZoneCandidates({ candidates, trail: TRAIL, polygons: [], triggerAt: T0 }).map(
        (c) => c.kind,
      ),
    ).toEqual(['keyFrame', 'firstFrame'])
  })

  it('a candidate the trail cannot speak for does not qualify — and does not disqualify the others', () => {
    // A frame whose instant is further from every trail point than the bound:
    // "unknown" is never "in the zone", but it must not empty the list either.
    const candidates: readonly NcStillCandidate[] = [
      { kind: 'keyFrame', timestamp: T0 + 16677 + TRAIL_MATCH_MAX_MS + 1 },
      { kind: 'firstFrame', timestamp: T0 },
    ]
    const kept = selectTriggerZoneCandidates({
      candidates,
      trail: TRAIL,
      polygons: [USCIO],
      triggerAt: T0,
    })
    expect(kept.map((c) => c.kind)).toEqual(['firstFrame'])
  })

  it('a candidate outside the zone survives when it is the ONLY one the trail can speak for', () => {
    const candidates: readonly NcStillCandidate[] = [
      { kind: 'keyFrame', timestamp: T0 + 5001 },
      { kind: 'lastFrame', timestamp: T0 + 900_000 },
    ]
    const kept = selectTriggerZoneCandidates({
      candidates,
      trail: TRAIL,
      polygons: [USCIO],
      triggerAt: T0,
    })
    expect(kept.map((c) => c.kind)).toEqual(['keyFrame', 'lastFrame'])
  })
})
