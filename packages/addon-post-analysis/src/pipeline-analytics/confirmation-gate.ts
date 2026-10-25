import type { NativeRecoveryEvidence } from '@camstack/types'
import type { ConfirmationGateSettings } from './confirmation-gate-settings.js'

/**
 * Detection confirmation gate — pure orchestration.
 *
 * Kills false-positive track births (static "person" phantoms, parked-truck
 * ghosts, misclassified static objects) by re-running object detection on the
 * hi-res native crop of each birth candidate's box BEFORE the track is created.
 * A birth is confirmed only when the crop yields a class-compatible detection
 * above `minConfidence`; otherwise it is suppressed.
 *
 * This module holds NO I/O — the crop fetch and re-detection are injected
 * ({@link ConfirmationGateDeps}) so it is fully unit-testable, and the
 * production wiring supplies the native-crop + `pipelineExecutor.runPipeline`
 * closures.
 *
 * Every path that could not MEASURE returns `undecided`, not `confirmed`. It
 * used to fail open, and on a camera whose native-lease miss rate is documented
 * at 17-50% — and accepted upstream as retry-by-design — that made the gate a
 * coin flip whose losing face was always a persisted phantom. The caller defers
 * an undecided birth and re-submits it on a later frame.
 */

/** Coarse detection group used for class compatibility. */
export type CoarseGroup = 'person' | 'vehicle' | 'animal' | 'other'

/**
 * Map a fine/raw detector or classifier class name to its coarse group. The
 * runtime detector already emits coarse `macroClass` values (person/vehicle/
 * animal), but a track's `className` may carry a finer class from a downstream
 * classifier — this normalizes both sides to the same three groups. Anything
 * unrecognized maps to `other`, which the compatibility check treats as
 * fail-open (compatible with everything) rather than a hard mismatch.
 */
export function coarseGroupForClass(className: string): CoarseGroup {
  const c = className.trim().toLowerCase()
  if (c === 'person' || c === 'people' || c === 'pedestrian' || c === 'human') return 'person'
  if (
    c === 'vehicle' ||
    c === 'car' ||
    c === 'truck' ||
    c === 'bus' ||
    c === 'van' ||
    c === 'motorcycle' ||
    c === 'motorbike' ||
    c === 'bicycle' ||
    c === 'bike'
  ) {
    return 'vehicle'
  }
  if (
    c === 'animal' ||
    c === 'dog' ||
    c === 'cat' ||
    c === 'bird' ||
    c === 'horse' ||
    c === 'sheep' ||
    c === 'cow' ||
    c === 'bear' ||
    c === 'deer' ||
    c === 'fox'
  ) {
    return 'animal'
  }
  return 'other'
}

/**
 * A re-detection in the crop is COMPATIBLE with the track's class when both map
 * to the same coarse group. When either side is unknown (`other`) we fail open
 * — treat it as compatible — so an unusual class never wrongly suppresses a
 * real track.
 */
export function isConfirmationCompatible(
  trackClassName: string,
  detectionMacroClass: string,
): boolean {
  const track = coarseGroupForClass(trackClassName)
  const det = coarseGroupForClass(detectionMacroClass)
  if (track === 'other' || det === 'other') return true
  return track === det
}

/** A rectangle in the unit square (crop-normalised) or in frame pixels. */
export interface GateRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Minimal shape of a re-detection result the gate inspects. */
export interface ConfirmationDetection {
  readonly macroClass: string
  readonly score: number
  /**
   * Where in the CROP the detector saw it, normalised to the crop's own
   * extent (`[0, 1]` on both axes). Optional: a re-detector that reports only
   * classes still confirms; it just cannot promote a secondary subject.
   */
  readonly bbox?: GateRect
  /**
   * `true` when the detector's OWN per-class floor refused this box (it came
   * back on the executor's discard trail as `below-threshold`). That floor is
   * the live tracker's bar, not the gate's: the GATE'S bar decides whether it
   * confirms (D925). It never becomes a secondary subject — the discard trail
   * carries no box the gate could place — and it names a suppression
   * `below-detector-floor` (D922).
   */
  readonly refusedByDetectorFloor?: boolean
}

/**
 * The session's own detector could not re-judge the crop (D925): the frame
 * named none, its device is in backoff or failed, or the executor would have
 * run another model or pool. NO measurement — the birth defers, and is
 * admitted once its deferral is exhausted. Another model is never asked.
 */
export interface SessionDetectorUnavailable {
  readonly unavailable: 'session-device-unavailable'
  readonly detail: string
}

/**
 * What a re-detect answers: the crop's detections, the session detector's
 * refusal, or `null` when inference itself failed.
 */
export type RedetectAnswer = readonly ConfirmationDetection[] | SessionDetectorUnavailable | null

function isSessionDetectorUnavailable(
  answer: RedetectAnswer,
): answer is SessionDetectorUnavailable {
  return answer !== null && 'unavailable' in answer
}

/**
 * A subject the crop confidently contains that is NOT the candidate — a dog
 * beside the person whose birth was being confirmed. Reported in FRAME pixels
 * so the caller can hand it to the tracker as a detection of its own.
 *
 * The camera-101 case that produced this: five instants where the full-frame
 * detector emitted no `animal` at all and the gate, re-running the same
 * detector on the person's 320 px native crop, found the dog at 0.74–0.91 —
 * and logged it. A measurement that confident, on a native crop, is a birth
 * candidate, not a footnote.
 */
export interface SecondarySubject {
  readonly className: string
  readonly score: number
  readonly bbox: GateRect
}

/** A candidate track birth to confirm (bbox in detection-frame pixel space). */
export interface BirthCandidate {
  readonly trackId: string
  readonly className: string
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  /**
   * What the runner's NATIVE-resolution second pass measured about this box,
   * when it is the pass that produced it (D377).
   *
   * This gate exists to ask one question of a birth: re-run the detector on
   * better pixels of the same instant and see whether the subject is really
   * there. `small-subject-recovery.ts` has ALREADY asked it — same detector,
   * same frame, a 640-800 px native square instead of the 320 px whole-frame
   * view — and that is how this box exists at all. Asking again, on a crop
   * this gate derives ITSELF (the box padded 15% and capped at 320 px wide,
   * so a 100 px dog arrives as a ~130 px blob with no context), is a third
   * toll on a worse measurement: camera 101, 2026-09-07, the same recovered
   * dog was confirmed at 0.7068 on one frame and found NOTHING compatible on
   * the next.
   *
   * So a candidate carrying this, at or above the bar it would have faced, is
   * `confirmed` on the measurement that saw it. It is an exemption, NOT a
   * bypass: below the bar, the ordinary crop path runs and decides, and a
   * raised per-candidate bar (`minConfidenceFor`) is honoured in full.
   */
  readonly nativeRecovery?: NativeRecoveryEvidence
  /**
   * The candidate's OWN pixels, cut by the runner on the frame this birth was
   * measured on and carried here with the detection (D379).
   *
   * This is the crop the gate would have asked for, taken at the only instant
   * at which asking is free — and, decisively, at the RIGHT instant. Over three
   * hours on the live hub the after-the-fact request missed 7 452 times, 99.9%
   * of them `worker-lease-gone`, at a median handle age of 1 347 ms and with
   * misses recorded as early as 254 ms: the frame is very often never retained
   * at all, so no window and no cap can rescue that path. 1 191 of 1 883 gate
   * verdicts (63%) never saw a pixel.
   *
   * Used FIRST, before any fetch — and CONFIRM-ONLY. It is the birth's own
   * instant, but it is cut from the ≤640 ANALYSIS raster, and the field says
   * what that costs: in the first twenty minutes this shipped, the carried crop
   * suppressed 133 of 192 births (69%) where the NATIVE crop of the same gate
   * suppressed 5 of 56 (9%). So a negative here is `carried-inconclusive` and
   * the candidate falls through to the native path, which decides as it always
   * did. The change is therefore monotone: it can only turn a `timeout` or a
   * `no-crop` into a `confirmed`.
   *
   * Answered AFTER the {@link nativeRecovery} exemption: a birth the native
   * second pass already measured costs no inference at all (D377), and a
   * carried crop still costs one.
   */
  readonly evidenceCrop?: Buffer
}

/**
 * Which pixels a verdict was taken on.
 *
 * On the decision rather than only in a log line because the three sources are
 * not interchangeable, and only ONE of them may suppress: `native` is a
 * full-resolution crop of the birth's own frame; `carried` is the same instant
 * at ≤640 analysis resolution; `fallback` is a DIFFERENT INSTANT entirely. The
 * last two may confirm and never kill a track (D379).
 */
export type ConfirmationCropSource = 'carried' | 'native' | 'fallback'

/**
 * What the gate concluded.
 *
 * `undecided` means NO MEASUREMENT HAPPENED — the crop never arrived, inference
 * was unavailable, time ran out, or the box was too small to re-detect. It is
 * deliberately neither of the other two: collapsing it into `confirmed` is the
 * defect this type exists to make impossible.
 */
export type ConfirmationVerdict = 'confirmed' | 'suppressed' | 'undecided'

/** Why a candidate was (or was not) confirmed — for structured logging. */
export type ConfirmationReason =
  | 'confirmed'
  /**
   * SUPPRESSED — the four ways a NATIVE crop of the birth instant says no
   * (D922). One name each, because they are remediated differently and the
   * old single `suppressed` made the ledger unable to tell an empty wall from
   * a person the detector half saw:
   *  - `scored-below-threshold`: a compatible box the detector kept, under the
   *    bar this candidate faced (the phantom-cell bar can raise it);
   *  - `below-detector-floor`: the best compatible box, under the bar, had
   *    also been refused by the detector's own per-class floor — `bestScore`
   *    is that box's score (since D925 the bar alone decides it);
   *  - `incompatible-class`: nothing compatible, something else confidently;
   *  - `no-detection`: the crop was measured and held nothing at all.
   */
  | 'scored-below-threshold'
  | 'below-detector-floor'
  | 'incompatible-class'
  | 'no-detection'
  | 'no-crop'
  | 'redetect-error'
  /**
   * The session's own detector could not re-judge the crop (D925) — see
   * {@link SessionDetectorUnavailable}. Undecided: deferred, then admitted.
   */
  | 'session-device-unavailable'
  | 'timeout'
  | 'below-min-crop'
  /**
   * The only crop available was a RIPPLE FROM ANOTHER INSTANT (the exhausted
   * birth's sub-native fallback), and it did not contain the subject. That is
   * not a measurement of the birth: a subject that moved is not in a later
   * frame, and its absence there says nothing about whether it was here.
   * Deliberately `undecided`, never `suppressed` — a fallback crop may confirm
   * and may never kill a track (D379).
   */
  | 'fallback-inconclusive'
  /**
   * The crop the birth CARRIED did not contain the subject — and that decides
   * nothing either. It is cut from the ≤640 analysis raster, so a subject that
   * is a ~130 px blob there is the third, worse image D377 measured as a coin
   * flip. Measured on the live hub: the carried crop suppressed 69% of births
   * where the native crop of the same gate suppressed 9%. The candidate falls
   * through to the native path, which decides as it always did (D379).
   */
  | 'carried-inconclusive'
  /** Confirmed on the runner's native second-pass measurement — no crop was
   *  cut, because the question this gate asks was already answered on better
   *  pixels of the same frame (D377). */
  | 'native-pass'

export interface ConfirmationDecision {
  readonly trackId: string
  readonly verdict: ConfirmationVerdict
  readonly reason: ConfirmationReason
  /**
   * The candidate's claimed class. Carried so a decision can be grouped per
   * class without joining back to the track — `minConfidence` is one scalar
   * for every class today, and deciding whether it should be per-class needs
   * the scores split by class.
   */
  readonly className: string
  /**
   * Best CLASS-COMPATIBLE re-detection score in the crop. This is the number
   * `minConfidence` is compared against, so it is also the number a bar must
   * be chosen from. Absent when there was no compatible detection at all —
   * deliberately NOT zero, which would pollute the distribution with
   * "measured, scored 0" cases that never happened.
   */
  readonly bestScore?: number
  /**
   * The strongest INCOMPATIBLE detection, when one exists. Separates "the crop
   * was empty" from "the crop confidently contains something else" — the
   * second is a misclassification signal, and the first is not.
   */
  readonly bestIncompatibleClass?: string
  readonly bestIncompatibleScore?: number
  /**
   * The bar this candidate was actually measured against — `config.minConfidence`
   * unless {@link ConfirmationGateDeps.minConfidenceFor} raised it. On the
   * decision rather than only in the caller's log line, because with a
   * per-candidate bar "was 0.62 a pass?" stopped being answerable from the
   * config. Absent on an `undecided`: no measurement was taken.
   */
  readonly appliedMinConfidence?: number
  /**
   * The strongest incompatible detection PROMOTED: it cleared the same bar the
   * candidate faced, it carried a box, and the crop's frame rectangle was
   * known. Independent of the verdict — a suppressed vehicle whose crop held
   * a confident animal yields one too, because the crop had the WRONG
   * subject, not no subject.
   */
  readonly secondary?: SecondarySubject
  /**
   * Which pixels this verdict was taken on. Absent on a decision that took no
   * measurement (`undecided` before any crop, `native-pass`), because naming a
   * source there would claim a crop that never existed.
   */
  readonly cropSource?: ConfirmationCropSource
}

export interface ConfirmationGateDeps {
  /**
   * The FRAME-pixel rectangle the candidate's crop was cut from — the padded,
   * clamped window `fetchCrop` asks the runner for. Without it a crop-
   * normalised box cannot be put back in the frame and no secondary is
   * promoted. Optional so a caller that only confirms stays unchanged.
   */
  readonly cropRectFor?: (candidate: BirthCandidate) => GateRect | null
  /** Fetch a hi-res NATIVE crop JPEG of the candidate's box. `null` = miss. */
  readonly fetchCrop: (candidate: BirthCandidate) => Promise<Buffer | null>
  /**
   * Last resort for a birth whose deferral is EXHAUSTED: a sub-native crop of
   * the same box (retained full frame, keyframe-native or the ≤640 RAM tier —
   * never upscaled). Optional; absent means an exhausted birth with no native
   * crop falls open.
   *
   * Only ever called for a candidate the caller marked exhausted. The point is
   * that a classification question ("vehicle or wall?") tolerates a resolution
   * that a recognition question would not.
   */
  readonly fetchFallbackCrop?: (candidate: BirthCandidate) => Promise<Buffer | null>
  /**
   * Re-run object detection on the crop JPEG with the SESSION'S detector
   * (D925). Returns the detections on success, the session detector's refusal
   * when it cannot serve, or `null` when inference errored — both undecided.
   */
  readonly redetect: (cropJpeg: Buffer) => Promise<RedetectAnswer>
  /**
   * Hand the host the pixels this candidate was judged on, as they are judged.
   *
   * The crop existed only inside `measure` and was never written anywhere, so
   * a verdict could not be argued with: on device 106 the gate retracted 18
   * births out of 18, each with the crop present and no compatible detection
   * in it, and whether the detector was right or the box/frame pairing was
   * skewed fits every number equally. The host decides whether to keep it —
   * see `MediaFileKind.confirmationCrop` — this module only offers it.
   *
   * Called for EVERY measured candidate, confirmations included: the host is
   * the one that knows which verdicts are worth bytes, and a seam that only
   * fired on refusals could never show what a healthy crop looks like.
   */
  readonly keepCrop?: (
    candidate: BirthCandidate,
    cropJpeg: Buffer,
    cropSource: ConfirmationCropSource,
  ) => void
  /**
   * PER-CANDIDATE spawn bar, overriding `config.minConfidence`.
   *
   * The seam the phantom-cell memory uses: a birth candidate born in a cell
   * that has closed short-and-motionless three or more times in 24 h faces a
   * higher bar than the same box a metre away. It is a FUNCTION rather than a
   * field because the answer depends on WHERE the candidate is, and passing a
   * pre-computed scalar would have made this a per-frame decision taken by the
   * caller — a second authority on a number this module already owns.
   *
   * Absent, or returning the config value, means "the ordinary bar". It can
   * only ever RAISE it (`phantomSpawnBar` is monotonic in the base); a hook
   * that lowered the bar would be a way to smuggle a birth past the gate.
   */
  readonly minConfidenceFor?: (candidate: BirthCandidate) => number
  /** Optional per-decision callback (structured logging / metrics). */
  readonly onDecision?: (decision: ConfirmationDecision) => void
}

const undecided = (
  candidate: BirthCandidate,
  reason: ConfirmationReason,
): ConfirmationDecision => ({
  trackId: candidate.trackId,
  verdict: 'undecided',
  reason,
  className: candidate.className,
  // No score: no measurement was taken. Reporting one would put a fabricated
  // number into the distribution the bar is read from.
})

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('confirmation-timeout')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

async function runConfirmation(
  candidate: BirthCandidate,
  config: ConfirmationGateSettings,
  deps: ConfirmationGateDeps,
  exhausted: boolean,
): Promise<ConfirmationDecision> {
  // 1) The pixels the birth ARRIVED WITH — the frame it was measured on, in
  //    hand, no fetch, no scheduler slot, no handle that may already be gone
  //    (D379). Tried FIRST and, when it confirms, it is the whole answer.
  //
  //    A NEGATIVE here decides nothing and escalates. Measured on the live hub
  //    in the twenty minutes after this shipped: the carried crop suppressed 133
  //    of 192 births (69%) while the NATIVE crop of the same gate suppressed 5
  //    of 56 (9%). It is cut from the ≤640 analysis raster, so a subject that
  //    is 130 px there is the "third, different, worse image" D377 measured as a
  //    coin flip — and "the detector found nothing in a blob" is not evidence
  //    the subject was absent. Confirm-only makes this change MONOTONE: it can
  //    turn a `timeout` or a `no-crop` into a `confirmed` and can never create
  //    a suppression, so nothing the gate used to catch stops being caught.
  const carried = candidate.evidenceCrop ?? null
  if (carried) {
    const verdict = await measure(candidate, carried, config, deps, 'carried')
    // A detector that cannot answer will not answer the native crop either.
    if (
      verdict.verdict === 'confirmed' ||
      verdict.reason === 'redetect-error' ||
      verdict.reason === 'session-device-unavailable'
    ) {
      return verdict
    }
  }
  let crop = await deps.fetchCrop(candidate)
  let cropSource: ConfirmationCropSource = 'native'
  if (!crop && exhausted && deps.fetchFallbackCrop) {
    // The deferral is over. A sub-native crop is a worse measurement than a
    // native one and a far better one than none: the alternative is confirming
    // a birth nobody ever looked at. But it is also a DIFFERENT INSTANT, which
    // is why `cropSource` follows it all the way to the verdict below.
    crop = await deps.fetchFallbackCrop(candidate)
    cropSource = 'fallback'
  }
  if (!crop) return undecided(candidate, 'no-crop')
  return measure(candidate, crop, config, deps, cropSource)
}

/**
 * Re-detect on ONE crop and turn the result into a verdict.
 *
 * Shared by all three sources so a crop can never be judged by two slightly
 * different rules depending on where it came from — the `cropSource` argument
 * is the ONLY thing that varies, and it varies in exactly one place below.
 */
async function measure(
  candidate: BirthCandidate,
  crop: Buffer,
  config: ConfirmationGateSettings,
  deps: ConfirmationGateDeps,
  cropSource: ConfirmationCropSource,
): Promise<ConfirmationDecision> {
  // Offered BEFORE the re-detect: the pixels are what they are whatever comes
  // back, and an inference that errors out is exactly a case worth looking at.
  deps.keepCrop?.(candidate, crop, cropSource)
  const detections = await deps.redetect(crop)
  if (detections === null) return undecided(candidate, 'redetect-error')
  if (isSessionDetectorUnavailable(detections)) {
    return undecided(candidate, 'session-device-unavailable')
  }

  // Split the crop's detections by class compatibility and keep the best of
  // each. The compatible best IS the value compared against `minConfidence`;
  // the incompatible best is evidence about WHY a suppression happened.
  let best: ConfirmationDetection | undefined
  let bestIncompatible: ConfirmationDetection | undefined
  //
  // ONE RULE (D925): the GATE'S bar decides every compatible box, kept or
  // refused by the detector's own per-class floor. That floor is the live
  // tracker's bar; the gate has its own (`minConfidence`, per camera, raised by
  // the phantom-cell hook) and it is the one asked to judge a birth. A refused
  // box never promotes a secondary (the discard trail carries no box to place).
  for (const d of detections) {
    const compatible = isConfirmationCompatible(candidate.className, d.macroClass)
    if (compatible) {
      if (!best || d.score > best.score) best = d
    } else if (d.refusedByDetectorFloor !== true) {
      if (!bestIncompatible || d.score > bestIncompatible.score) bestIncompatible = d
    }
  }

  const bar = barFor(candidate, config, deps)
  const confirmed = best !== undefined && best.score >= bar
  // A RIPPLE FROM ANOTHER INSTANT MAY CONFIRM AND MAY NEVER SUPPRESS (D379).
  //
  // `fetchFallbackCrop` cuts from a LATER frame, and the gate's question is
  // about THIS birth. Finding the subject there proves it was here; not finding
  // it proves only that it is not there NOW — a walking dog is a metre away and
  // the box it was in holds grass. Treating that as a false positive kills the
  // track, and with it the object event, the notification and the events-reel
  // entry, which the operator requires to coincide.
  //
  // This is a strictly narrower fail-open than the one this gate replaced in
  // 2026-08-01: it applies to the fallback crop ALONE. A native or carried crop
  // — same instant, real evidence — still suppresses, and the phantom-cell bar
  // (`minConfidenceFor`) still raises the bar for the static box a fallback
  // WOULD have caught, because a wall does not move between two frames and
  // closes short-and-motionless over and over.
  // The two sources that are not a native measurement of the birth instant may
  // confirm and may never suppress — for two different reasons, both measured:
  // `fallback` looks at a LATER frame (a subject that moved is not in it), and
  // `carried` is cut from the ≤640 analysis raster (69% suppression against the
  // native crop's 9% on the same births). Only `native` decides both ways.
  if (!confirmed && cropSource !== 'native') {
    return undecided(
      candidate,
      cropSource === 'fallback' ? 'fallback-inconclusive' : 'carried-inconclusive',
    )
  }
  const secondary = bestIncompatible
    ? promoteSecondary(candidate, bestIncompatible, bar, deps)
    : null
  // The score the decision is reported with — the best compatible box, kept or
  // floor-refused. Absent when the crop held nothing compatible at all — never
  // a fabricated 0.
  return {
    trackId: candidate.trackId,
    verdict: confirmed ? 'confirmed' : 'suppressed',
    reason: confirmed ? 'confirmed' : suppressionReason(best, bestIncompatible),
    className: candidate.className,
    appliedMinConfidence: bar,
    cropSource,
    ...(best ? { bestScore: best.score } : {}),
    ...(bestIncompatible
      ? {
          bestIncompatibleClass: bestIncompatible.macroClass,
          bestIncompatibleScore: bestIncompatible.score,
        }
      : {}),
    ...(secondary ? { secondary } : {}),
  }
}

/**
 * Why a measured native crop said no — first matching rule wins (D922). The
 * best compatible box is under the gate's bar either way; `below-detector-floor`
 * says the detector's own floor had refused it too (D925).
 */
function suppressionReason(
  best: ConfirmationDetection | undefined,
  bestIncompatible: ConfirmationDetection | undefined,
): ConfirmationReason {
  if (best !== undefined) {
    return best.refusedByDetectorFloor === true ? 'below-detector-floor' : 'scored-below-threshold'
  }
  if (bestIncompatible !== undefined) return 'incompatible-class'
  return 'no-detection'
}

/**
 * The incompatible best becomes a secondary subject when it clears the SAME
 * bar the candidate faced and can be placed in the frame. The crop-normalised
 * box is scaled into the crop's frame rectangle — the one derivation the
 * capture used, supplied by the caller, never re-derived here.
 */
function promoteSecondary(
  candidate: BirthCandidate,
  detection: ConfirmationDetection,
  bar: number,
  deps: ConfirmationGateDeps,
): SecondarySubject | null {
  if (detection.score < bar || detection.bbox === undefined) return null
  const rect = deps.cropRectFor?.(candidate) ?? null
  if (rect === null || rect.w <= 0 || rect.h <= 0) return null
  const box = detection.bbox
  return {
    className: detection.macroClass,
    score: detection.score,
    bbox: {
      x: rect.x + box.x * rect.w,
      y: rect.y + box.y * rect.h,
      w: box.w * rect.w,
      h: box.h * rect.h,
    },
  }
}

/**
 * The bar this candidate faces. Never below the configured one: the
 * `minConfidenceFor` hook is monotonic by construction, and clamping here says
 * so at the point of use rather than trusting the caller to have been careful.
 */
function barFor(
  candidate: BirthCandidate,
  config: ConfirmationGateSettings,
  deps: ConfirmationGateDeps,
): number {
  return Math.max(config.minConfidence, deps.minConfidenceFor?.(candidate) ?? 0)
}

async function confirmOne(
  candidate: BirthCandidate,
  config: ConfirmationGateSettings,
  deps: ConfirmationGateDeps,
  exhausted: boolean,
): Promise<ConfirmationDecision> {
  // ALREADY MEASURED, at native resolution, on this frame (D377). Answered
  // BEFORE the min-crop skip and before any fetch: this is the one candidate
  // class for which a second look has provably already happened, and every
  // line below it can only re-ask the same question of worse pixels.
  const native = candidate.nativeRecovery
  if (native !== undefined) {
    const bar = barFor(candidate, config, deps)
    if (native.score >= bar) {
      const decision: ConfirmationDecision = {
        trackId: candidate.trackId,
        verdict: 'confirmed',
        reason: 'native-pass',
        className: candidate.className,
        bestScore: native.score,
        appliedMinConfidence: bar,
      }
      return decision
    }
  }
  // Tiny boxes are too small to re-detect reliably — skip + fail open.
  const cropPx = Math.max(candidate.bbox.w, candidate.bbox.h)
  if (config.minCropPx > 0 && cropPx < config.minCropPx) {
    return undecided(candidate, 'below-min-crop')
  }
  try {
    return await withTimeout(runConfirmation(candidate, config, deps, exhausted), config.timeoutMs)
  } catch {
    // Timeout OR an unexpected throw in the injected deps → allow the birth.
    return undecided(candidate, 'timeout')
  }
}

/**
 * The gate's answer for a batch.
 *
 * Suppressed is the REMAINDER — two sets rather than "confirmed, and everything
 * else" is what stops a caller inheriting the old boolean by accident: there is
 * no single set it can treat as "may proceed".
 */
export interface ConfirmationOutcome {
  readonly confirmed: ReadonlySet<string>
  readonly undecided: ReadonlySet<string>
}

/**
 * One RUN of the gate: its answer, plus the decision it took about each
 * candidate (D409).
 *
 * The decisions were already available to the caller through `onDecision`, and
 * only as a side effect — so the birth loop, which is where `matchedThisFrame`,
 * the deferral clock and the track's `firstSeen` live, could not see WHY a
 * birth was confirmed. Returning them makes the two halves of the birth-decision
 * measurement joinable without a member field that several in-flight frames
 * would race on.
 *
 * `decisions` is empty when the gate is DISABLED or had no candidates: no
 * decision was taken, which is not the same as a decision with no reason.
 */
export interface BirthConfirmationRun {
  readonly outcome: ConfirmationOutcome
  readonly decisions: ReadonlyMap<string, ConfirmationDecision>
  /**
   * The pixels each candidate was judged on, by trackId — offered through
   * {@link ConfirmationGateDeps.keepCrop} and held only for this run.
   *
   * Empty unless the host asked for them. It is the host that decides which
   * verdicts are worth persisting: a crop kept for a track that is about to be
   * retracted would be a media row with no owner, which is the 18.9 GB lesson
   * of D161.
   */
  readonly crops: ReadonlyMap<string, Buffer>
}

/**
 * Confirm a batch of birth candidates CONCURRENTLY. When the gate is disabled
 * (or there are no candidates) every candidate is confirmed — byte-identical to
 * no gate. The caller runs this once, then processes the confirmed births,
 * defers the undecided ones, and retracts the rest, preserving the original
 * birth-loop ordering.
 */
export async function confirmBirths(
  candidates: readonly BirthCandidate[],
  config: ConfirmationGateSettings,
  deps: ConfirmationGateDeps,
  /**
   * Candidates whose deferral the CALLER has decided is over. Only these may
   * reach `fetchFallbackCrop`, and only these fall open when even that misses —
   * the gate itself holds no clock, so exhaustion is not something it can know.
   */
  exhaustedIds: ReadonlySet<string> = new Set<string>(),
): Promise<ConfirmationOutcome> {
  if (!config.enabled || candidates.length === 0) {
    return {
      confirmed: new Set(candidates.map((c) => c.trackId)),
      undecided: new Set(),
    }
  }
  const decisions = await Promise.all(
    candidates.map((c) => confirmOne(c, config, deps, exhaustedIds.has(c.trackId))),
  )
  const confirmed = new Set<string>()
  const pending = new Set<string>()
  for (const decision of decisions) {
    deps.onDecision?.(decision)
    if (decision.verdict === 'confirmed') confirmed.add(decision.trackId)
    else if (decision.verdict === 'undecided') {
      // An exhausted birth cannot stay undecided — nothing would ever resolve
      // it, and the caller would hold it forever. This is the ONE remaining
      // fail-open, and it is now a bounded last resort rather than the routine
      // outcome of every crop miss.
      if (exhaustedIds.has(decision.trackId)) confirmed.add(decision.trackId)
      else pending.add(decision.trackId)
    }
  }
  return { confirmed, undecided: pending }
}
