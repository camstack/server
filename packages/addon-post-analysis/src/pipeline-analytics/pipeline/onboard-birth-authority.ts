/**
 * WHO may retract a birth, and on whose word.
 *
 * The confirmation gate re-runs the ML detector on a crop of the birth frame
 * and retracts the track when it finds nothing compatible. On the `pipeline`
 * path that is a COHERENCE CHECK: the same detector, asked the same question
 * about a tighter crop, and a disagreement really does mean the first answer
 * was noise.
 *
 * On the `onboard` path it is not. There the root detector is the CAMERA's own
 * firmware, and the gate is a second, different detector overruling it. A
 * disagreement between two detectors is not evidence that one of them is
 * wrong — and the action taken on it is one-shot and destructive, which is
 * exactly the shape D49 forbids resting on a fallible read.
 *
 * Measured on device 106 (Baby monitor, the only camera on this fleet with
 * `detectionSources: ['onboard']`), 2026-09-15: the operator walked in front of
 * the camera and the firmware saw `person` for ~100 s continuously. The gate
 * retracted **18 births out of 18** in three hours — every one with
 * `cropSource=native` (the crop arrived) and no `bestScore` at all (the ML
 * found nothing compatible in it). Nothing survived: no track persisted, no
 * thumbnail, no recording. The event happened and left no trace.
 *
 * So on an onboard root a suppression HOLDS the birth instead of retracting
 * it, and says so. That is the same direction D501 took for the stationary TTL
 * a few hours earlier: a detector that does not name something is not a
 * detector reporting its absence.
 *
 * This is deliberately NOT a blanket "never retract". A camera running
 * `pipeline` — every other camera on this fleet — keeps the gate whole, and a
 * camera running BOTH roots keeps it too: there the ML is a root detector in
 * its own right, so its verdict is its own to give.
 */

/** The detection source a birth came in on (`DetectionSource`, narrowed here to
 *  what this rule turns on). */
export type BirthDetectionSource = string

/**
 * May a suppression verdict RETRACT this birth?
 *
 * `false` means hold: keep the track, log the held verdict, and let the
 * ordinary lifetime decide. It never means "confirmed".
 */
export function suppressionMayRetract(source: BirthDetectionSource): boolean {
  return source !== 'onboard'
}
