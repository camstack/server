/**
 * `subjectAgreement` — the ONE predicate for "a rectangle measured on frame A
 * is still honest against the pixels of frame B".
 *
 * Two durable display crops cut a rectangle out of a frame that is NOT the
 * frame the rectangle was measured on: the close-time thumbnail derive (the
 * best-seen subject box, cut from the persisted keyFrame) and the plate
 * gallery's last-resort crop (the plate rect at the best OCR read, cut from the
 * same keyFrame). Both were guarded on TIME alone, and time is the wrong
 * quantity: 1.5 s is nothing for a parked car and hundreds of native pixels for
 * a car crossing the frame. Confirmed on the operator's debug-marked tracks
 * (2026-08-30 triage): `e9c024bb` passed the time bound at 531–1179 ms and
 * stored a windshield and a patch of gravel, while `7613c0fa` — the same path,
 * 2579 ms of skew, a stationary vehicle — stored a perfectly framed plate.
 *
 * The quantity that separates those cases is MOTION, and the track's own
 * `positions` trail already records it. This asks the trail one question:
 *
 *   between the instant the rectangle was measured and the instant the pixels
 *   were captured, did the subject stay where it was?
 *
 * IoU over the two subject boxes answers it, and because both boxes come from
 * the SAME trail they are in the same detection-frame pixel space by
 * construction — there is no cross-space normalization to get wrong.
 *
 * D52's one-derivation discipline applied to the guard: this is the only place
 * the question is answered, and {@link createKeyFrameCrop} is its only caller,
 * so both defects share one contract instead of two drifting copies.
 *
 * `unknown` is a real verdict, not a failure: a track with no trail, or a trail
 * downsampled away from one of the two instants, carries NO motion evidence.
 * The caller then falls back to the temporal bound it always had — an absent
 * read changes nothing (D49).
 */
import { iou, type PixelBox } from './event-child-crops.js'

/** One timestamped subject box off the track's `positions` trail. */
export interface SubjectPathSample {
  readonly timestamp: number
  readonly bbox: PixelBox
}

/** Why the trail could not answer. Each value is a distinct trail shape, and
 *  they are counted separately so "no positions at all" never hides inside
 *  "the trail was downsampled past the instant I asked about". */
export type SubjectAgreementUnknownReason =
  | 'no-path'
  | 'no-sample-near-measure'
  | 'no-sample-near-cut'

/**
 * The verdict.
 *
 *  - `agrees` — the subject occupied the same box at both instants, so the
 *    rectangle is honest against those pixels HOWEVER large the time skew is.
 *    This is what rescues the stationary-vehicle case that the pure time bound
 *    refuses (`7613c0fa`, skew 2579 ms, IoU 1.000, image correct).
 *  - `moved` — the subject was somewhere else. The rectangle would cut scene.
 *  - `unknown` — no motion evidence; the caller's temporal bound decides.
 */
export type SubjectAgreementVerdict =
  | { readonly kind: 'agrees'; readonly iou: number; readonly sampleGapMs: number }
  | { readonly kind: 'moved'; readonly iou: number; readonly sampleGapMs: number }
  | { readonly kind: 'unknown'; readonly reason: SubjectAgreementUnknownReason }

export interface SubjectAgreementQuery {
  /** The track's position trail (any order; only timestamps are used to seek). */
  readonly path: readonly SubjectPathSample[]
  /** Instant the rectangle being cut was MEASURED (frame A). */
  readonly measuredAtMs: number
  /** Instant of the pixels being cut FROM (frame B — the persisted keyFrame). */
  readonly cutFromMs: number
  /** IoU at or above which the two instants are treated as agreeing. */
  readonly minIou: number
  /** How far a trail sample may sit from an instant and still be evidence
   *  ABOUT that instant. Beyond it the trail was downsampled past the moment
   *  and the honest answer is `unknown`, not an interpolated guess. */
  readonly maxSampleGapMs: number
}

interface NearestSample {
  readonly bbox: PixelBox
  readonly gapMs: number
}

function nearestSample(
  path: readonly SubjectPathSample[],
  atMs: number,
  maxSampleGapMs: number,
): NearestSample | undefined {
  let best: SubjectPathSample | undefined
  let bestGap = Number.POSITIVE_INFINITY
  for (const sample of path) {
    const gap = Math.abs(sample.timestamp - atMs)
    if (gap < bestGap) {
      bestGap = gap
      best = sample
    }
  }
  if (best === undefined || bestGap > maxSampleGapMs) return undefined
  return { bbox: best.bbox, gapMs: bestGap }
}

/**
 * Answer "did the subject stay put between the two instants?" from the track's
 * own position trail. Pure — no IO, no clock, no logging: the caller owns the
 * consequence and the line it writes.
 */
export function subjectAgreement(query: SubjectAgreementQuery): SubjectAgreementVerdict {
  if (query.path.length === 0) return { kind: 'unknown', reason: 'no-path' }
  const atMeasure = nearestSample(query.path, query.measuredAtMs, query.maxSampleGapMs)
  if (atMeasure === undefined) return { kind: 'unknown', reason: 'no-sample-near-measure' }
  const atCut = nearestSample(query.path, query.cutFromMs, query.maxSampleGapMs)
  if (atCut === undefined) return { kind: 'unknown', reason: 'no-sample-near-cut' }
  const overlap = iou(atMeasure.bbox, atCut.bbox)
  const sampleGapMs = Math.max(atMeasure.gapMs, atCut.gapMs)
  return overlap >= query.minIou
    ? { kind: 'agrees', iou: overlap, sampleGapMs }
    : { kind: 'moved', iou: overlap, sampleGapMs }
}
