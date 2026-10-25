/**
 * first-last-frame-order — the close-time INVARIANT that a track's "primo"
 * tile is not newer than its "ultimo" tile.
 *
 * The operator filed it three times by hand on device 3829 (2026-09-08), once
 * as "Ancora ultimo frame prima del primo" [Still last frame before the first]. Tracks `d035f251`, `448678bb` and
 * `7628b19d` each stored a `firstFrame` NEWER than their `lastFrame`; on two of
 * them the `firstFrame` also post-dated the track's own `lastSeen` by ~450 ms.
 *
 * The cause is upstream ({@link ./birth-first-frame-gate.js}): the `firstFrame`
 * is captured at the CONFIRMED-birth frame, and the confirmation gate may defer
 * a birth by up to `maxDeferralMs` (2 s by default) before releasing it — while
 * `keyFrame`, `thumbnail` and the close-time `lastFrame` copy are all stamped at
 * the earlier frame they were actually cut from. The birth gate stops NEW tracks
 * from producing the inversion; this module repairs a pair that already has one,
 * and is the invariant that holds regardless of which capture path drifts next.
 *
 * The repair is a SWAP, not a delete: both rows hold real stored pixels of the
 * same track, and the only thing wrong with them is which slot they sit in. The
 * older bytes are the track's first view, the newer bytes are its last. Nothing
 * is fetched, nothing is re-encoded and no media is lost.
 *
 * Explicitly NOT an inversion: `first === last`. A track shorter than the
 * lastFrame interval has exactly ONE honest view and both slots showing it is
 * the correct answer — that is the whole point of the close-time `keyFrameSmall`
 * copy in {@link ./last-frame-promotion.js}.
 *
 * Holds NO I/O so it is fully unit-testable; the caller (`closeExpired`)
 * supplies the track's owned media and executes the store operation.
 */

import type { MediaFileBytes } from '@camstack/types'

/**
 * WHY no swap was made. Every value is a distinct branch:
 *
 *  - `ordered` — the held `firstFrame` is at or before the held `lastFrame`.
 *    The healthy path, and the one a sub-interval track lands on when the two
 *    collapse onto a single frame.
 *  - `no-first-frame` / `no-last-frame` — one of the two slots is empty, so
 *    there is no PAIR to order. Whether the absent one is a defect is
 *    `decideLastFramePromotion`'s question and the debug analysis's, not this
 *    module's.
 */
export type FirstLastFrameOrderSkip = 'ordered' | 'no-first-frame' | 'no-last-frame'

export type FirstLastFrameOrderDecision =
  | { readonly swap: false; readonly skippedBecause: FirstLastFrameOrderSkip }
  | {
      readonly swap: true
      /** Media id (D482) of the row currently in the `firstFrame` slot — the
       *  NEWER bytes, which belong in the `lastFrame` slot. */
      readonly firstFrameMediaId: number
      /** Media id (D482) of the row currently in the `lastFrame` slot — the
       *  OLDER bytes, which belong in the `firstFrame` slot. */
      readonly lastFrameMediaId: number
      /** Frame instant currently stamped on the `firstFrame` row. */
      readonly firstFrameTimestamp: number
      /** Frame instant currently stamped on the `lastFrame` row. */
      readonly lastFrameTimestamp: number
      /** How far the "primo" tile post-dates the "ultimo" tile (ms). The number
       *  the log line and the operator-facing finding both carry. */
      readonly inversionMs: number
    }

/**
 * Decide whether a closing track's `firstFrame` and `lastFrame` slots hold each
 * other's bytes. Pure — see the module header for the contract.
 *
 * Swap when BOTH slots are filled and the `firstFrame` is STRICTLY newer than
 * the `lastFrame`. Equal timestamps are not an inversion.
 */
export function decideFirstLastFrameOrder(
  media: readonly MediaFileBytes[],
): FirstLastFrameOrderDecision {
  let firstFrame: MediaFileBytes | undefined
  let lastFrame: MediaFileBytes | undefined
  for (const m of media) {
    // Both are single-instance kinds — at most one each — but keep the newest
    // defensively should a legacy duplicate linger, exactly as
    // `decideLastFramePromotion` does for `lastFrame`.
    if (m.kind === 'firstFrame') {
      if (firstFrame === undefined || m.timestamp > firstFrame.timestamp) firstFrame = m
    } else if (m.kind === 'lastFrame') {
      if (lastFrame === undefined || m.timestamp > lastFrame.timestamp) lastFrame = m
    }
  }
  if (firstFrame === undefined) return { swap: false, skippedBecause: 'no-first-frame' }
  if (lastFrame === undefined) return { swap: false, skippedBecause: 'no-last-frame' }
  if (firstFrame.timestamp <= lastFrame.timestamp) {
    return { swap: false, skippedBecause: 'ordered' }
  }
  return {
    swap: true,
    firstFrameMediaId: firstFrame.mediaId,
    lastFrameMediaId: lastFrame.mediaId,
    firstFrameTimestamp: firstFrame.timestamp,
    lastFrameTimestamp: lastFrame.timestamp,
    inversionMs: firstFrame.timestamp - lastFrame.timestamp,
  }
}
