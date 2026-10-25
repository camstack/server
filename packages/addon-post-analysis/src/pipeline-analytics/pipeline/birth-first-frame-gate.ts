/**
 * birth-first-frame-gate — may the CONFIRMED birth frame produce this track's
 * `firstFrame`?
 *
 * The `firstFrame` is captured on the frame the confirmation gate finally
 * RELEASES a birth on, which is not the frame the track was born on: the gate
 * defers an undecided birth for up to `maxDeferralMs` (2 s by default) and then
 * decides on whatever frame it is holding. For a track shorter than that
 * deferral, "whatever frame it is holding" is routinely a COASTED one — the
 * tracker carrying a frozen box after the subject stopped matching.
 *
 * Capturing there does two wrong things at once. The stored tile is cut from a
 * scene the subject is no longer in (the same reason `collectFirstFrameRetries`,
 * `buildSnapshotTargets` and the detail dispatcher all refuse a coasted frame —
 * D397), and it is stamped LATER than the `keyFrame` / `thumbnail` / promoted
 * `lastFrame` the track already holds, so the "primo" tile post-dates the
 * "ultimo" one. Live on device 3829, 2026-09-08: `d035f251` (firstFrame 451 ms
 * after the track's own `lastSeen`, 1837 ms after its `lastFrame`), `448678bb`
 * and `7628b19d` — filed by hand by the operator as "ultimo frame prima del
 * primo", all three also flagged "traccia partita in ritardo".
 *
 * Refusing here does NOT forfeit the firstFrame: the caller marks the birth
 * `firstFramePending` unconditionally, so the first LATER matched+handled frame
 * still recovers it (D58 — the retry is untouched, only this one dispatch is
 * withheld). A track that never matches again closes without a `firstFrame`,
 * which the debug analysis reports honestly as `MISSING_FIRSTFRAME` — strictly
 * better than a tile that lies about both its pixels and its instant.
 */

/** WHY the birth frame could not produce the track's first view. */
export type BirthFirstFrameRefusal =
  /**
   * The tracker carried this track through the frame without matching a
   * detection. Not a frame the subject was in, so not a frame its first view
   * may be cut from.
   */
  | 'coasted-frame'
  /**
   * Decode / retained-frame starvation — there are no pixels to crop THIS
   * frame. The pre-existing gate, kept as a named reason so the two are
   * distinguishable in the log.
   */
  | 'no-frame-handle'

export type BirthFirstFrameDecision =
  | { readonly capture: true }
  | { readonly capture: false; readonly refusedBecause: BirthFirstFrameRefusal }

export interface BirthFirstFrameInput {
  /** Does this frame carry a resolvable frame handle? */
  readonly hasFrameHandle: boolean
  /**
   * Did the tracker MATCH a real detection for this track this frame?
   *
   * ABSENT means yes, mirroring `TrackedDetection.matchedThisFrame` and every
   * other consumer of it — a tracker output that predates the flag behaves
   * exactly as before.
   */
  readonly matchedThisFrame?: boolean
}

/**
 * Decide whether the confirmed-birth frame may be dispatched as this track's
 * `firstFrame` capture. Pure; the caller logs the refusal and keeps the
 * `firstFramePending` mark so a later frame retries.
 *
 * `coasted-frame` is reported ahead of `no-frame-handle` when both hold: a
 * handle-less coasted frame would have been refused for BEING coasted whatever
 * the decode plane did, and naming the decode is what would send the next
 * investigation at the wrong subsystem.
 */
export function decideBirthFirstFrameCapture(input: BirthFirstFrameInput): BirthFirstFrameDecision {
  if (input.matchedThisFrame === false) {
    return { capture: false, refusedBecause: 'coasted-frame' }
  }
  if (!input.hasFrameHandle) return { capture: false, refusedBecause: 'no-frame-handle' }
  return { capture: true }
}
