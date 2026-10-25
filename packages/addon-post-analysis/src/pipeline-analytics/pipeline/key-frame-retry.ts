/**
 * When a track's native `keyFrame` is (re)captured.
 *
 * ## The defect this replaces
 *
 * The two best-shot media kinds were written a line apart and gated
 * differently:
 *
 * ```
 * thumbnail:  isNewBest || !thumbnailLanded   ← re-fires every frame until one lands
 * keyFrame:   isNewBest                       ← only
 * ```
 *
 * `isNewBest` is a best-frame PEAK signal (hysteresis 0.05, 2 s min gap), so
 * most tracks raise it once. Measured on the live hub 2026-08-06: of 102
 * tracks that logged a native-capture miss, 494 (80%) got exactly ONE capture
 * attempt in their entire life; the miss line promised "will retry next best"
 * and for four tracks in five there was no next best. 388 of the 542 surviving
 * miss-logged tracks (71.6%) never got a key frame, and nothing at close
 * recovers one — `track-close.ts` derives the thumbnail FROM the key frame,
 * never the reverse. Fleet-wide that is 21.7% of stored tracks permanently
 * absent from semantic search after any rebuild.
 *
 * ## Why it is bounded, unlike the thumbnail
 *
 * A key-frame attempt is a NATIVE FULL-FRAME fetch at 4096 px — the most
 * expensive capture in the addon, an order above the thumbnail's subject crop.
 * The hub is already saturated (measured the same night: 70–95% main thread,
 * load 29 on 20 cores, 42 s of synchronous blocks in a 120 s window). An
 * unbounded per-frame retry at ~10 fps would be a capture storm on exactly the
 * cameras that are already failing.
 *
 * So the retry path — and ONLY the retry path — is bounded three ways:
 *  - at most {@link KEY_FRAME_MAX_RETRIES} retries per track, ever;
 *  - never closer together than {@link KEY_FRAME_RETRY_MIN_GAP_MS};
 *  - dispatched at {@link KEY_FRAME_RETRY_PRIORITY}, BELOW the tier-1 keyFrame
 *    and below the thumbnail, so a retry can only ever consume a device lane
 *    slot the live media ladder did not want.
 *
 * The genuine new-best path is unchanged and uncharged: it is already
 * rate-limited by the best-frame policy, and charging it would make a peaking
 * track stop capturing its own best shot.
 */

/** What the decision knows about the track's key-frame history. */
export interface KeyFrameCaptureState {
  /** A `keyFrame` write has ACTUALLY landed for this track. */
  readonly landed: boolean
  /** Retry-path attempts spent so far (new-best attempts are not counted). */
  readonly retries: number
  /** Wall clock of the last attempt of EITHER path; undefined if never. */
  readonly lastAttemptAt: number | undefined
}

export interface KeyFrameCaptureInput {
  /** This frame is a genuine new best-detection peak for the track. */
  readonly isNewBest: boolean
  /** This frame's box passed the void/envArea plausibility guard. */
  readonly plausibleBox: boolean
  readonly state: KeyFrameCaptureState
  readonly now: number
}

/**
 * Why the capture fires — a discriminated union rather than a boolean because
 * the two paths differ in scheduler priority and in whether they are charged
 * against the retry budget, and a boolean would lose that at the call site.
 */
export type KeyFrameCaptureDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'new-best' }
  | { readonly kind: 'retry' }

/** Retry-path attempts allowed per track. The operator's number. */
export const KEY_FRAME_MAX_RETRIES = 3

/**
 * Floor on the spacing between key-frame attempts. Mirrors the best-frame
 * policy's own 2 s min gap, so a retry can never fire between two frames of
 * the same second on a 10 fps camera.
 */
export const KEY_FRAME_RETRY_MIN_GAP_MS = 2_000

/**
 * Scheduler priority for the RETRY path (0 = highest). Deliberately 3 —
 * `lastFrame`/`snapshot`/`timeline` rank — so it sits below the tier-1
 * `keyFrame` (1) and the `thumbnail` (2) it is trying to catch up with, and
 * above enrichment (4): a track that cannot be re-embedded is worth more than
 * a gallery tile, but never worth delaying the live media ladder for.
 */
export const KEY_FRAME_RETRY_PRIORITY = 3

/**
 * Decide whether this frame captures the track's native key frame, and on
 * which path.
 *
 * Pure: the caller owns the state and advances it when an exec actually runs,
 * not when a target is built — a re-fire that coalesces onto an in-flight
 * capture must not spend a retry.
 */
export function decideKeyFrameCapture(input: KeyFrameCaptureInput): KeyFrameCaptureDecision {
  // The void/envArea guard applies to BOTH paths. A retry that locked in a
  // full-frame void tile would set `landed` and stop the real retries — the
  // #27-A failure, one kind over.
  if (!input.plausibleBox) return { kind: 'skip' }
  if (input.isNewBest) return { kind: 'new-best' }
  if (input.state.landed) return { kind: 'skip' }
  if (input.state.retries >= KEY_FRAME_MAX_RETRIES) return { kind: 'skip' }
  const last = input.state.lastAttemptAt
  if (last !== undefined && input.now - last < KEY_FRAME_RETRY_MIN_GAP_MS) return { kind: 'skip' }
  return { kind: 'retry' }
}
