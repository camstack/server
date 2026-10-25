/**
 * last-frame-promotion — the pure close-time decision that makes `lastFrame`
 * genuinely the LAST view of a track (operator design, 2026-07-22).
 *
 * The rolling `lastFrame` deliberately never fires on a `snapshot` frame (the
 * anti-duplicate rule) and rolls on its own `snapshotIntervalMs` cadence, so at
 * track close it can trail the newest appended `snapshot` by up to one interval
 * — the "Ultimo" tile then shows a frame OLDER than the last filmstrip image.
 *
 * At close we reconcile: if the track's newest `snapshot` is NEWER than its held
 * `lastFrame` (or there is no `lastFrame` at all but ≥1 snapshot), that snapshot
 * IS the genuinely-last view and should become the `lastFrame`. Both kinds share
 * the same 960-boxed rendering, so the caller PROMOTES it — rewrites the newest
 * snapshot into the single `lastFrame` slot and drops the snapshot row, leaving
 * no duplicate pair and no extra retained media.
 *
 * This module holds NO I/O so it is fully unit-testable; the caller
 * (`sweepExpiredTracks`) supplies the track's owned media list and executes the
 * store operation.
 */

import type { MediaFileBytes } from '@camstack/types'

/**
 * WHY a close produced no `lastFrame`. Every value is a distinct branch, and
 * before D400 all of them were the same silent `{promote:false}` — which is how
 * the operator came to file "niente primo e ultimo" and "niente ultimo" as two
 * separate complaints about what is one upstream failure.
 *
 *  - `already-last` — a `lastFrame` at least as new as the newest snapshot is
 *    already held. Nothing is missing; this is the healthy path.
 *  - `no-key-frame` — the track has no snapshot, no lastFrame AND no
 *    `keyFrameSmall`. The copy source does not exist because the NATIVE KEY
 *    FRAME never landed: `keyFrame` missing ⇒ `keyFrameSmall` missing ⇒ no
 *    `copy` source ⇒ no lastFrame. The cause is the key-frame capture, not
 *    this decision, and the caller must say so rather than let the operator
 *    read it as an independent last-frame defect.
 *  - `no-source` — no snapshot and no `keyFrameSmall`, but a `lastFrame` is
 *    already held (so nothing needs promoting and nothing is missing).
 */
export type LastFramePromotionDecline = 'already-last' | 'no-key-frame' | 'no-source'

export type LastFramePromotionDecision =
  | { readonly promote: false; readonly declinedBecause: LastFramePromotionDecline }
  | {
      readonly promote: true
      /** `'move'`: promote the newest snapshot (rewrite + drop the snapshot
       *  row). `'copy'`: the track has NO snapshot and NO lastFrame (it died
       *  within one snapshot interval — live evidence 2026-07-23, 4-5s vehicle
       *  tracks on dev102 always closed lastFrame-less); copy the newest
       *  full-frame `keyFrameSmall` bytes into the lastFrame slot, KEEPING the
       *  keyFrame row (it serves its own kind). Same 960-boxed rendering
       *  family, so the tile stays visually consistent. */
      readonly mode: 'move' | 'copy'
      /** Media id (D482) of the source row (newest snapshot, or keyFrameSmall). */
      readonly snapshotMediaId: number
      /** Its frame timestamp — becomes the promoted `lastFrame`'s timestamp. */
      readonly snapshotTimestamp: number
    }

/**
 * Decide whether a closing track's newest `snapshot` should be promoted to be
 * its `lastFrame`. Pure — see the module header for the contract.
 *
 * Promote (`mode:'move'`) when there is at least one `snapshot` AND either
 * there is no `lastFrame` yet, or the newest snapshot is strictly newer than
 * the held `lastFrame`. With NO snapshot AND NO lastFrame at all (a track that
 * died within one snapshot interval), fall back to `mode:'copy'` from the
 * newest `keyFrameSmall` so a short track still closes with a full-frame
 * "Ultimo" view. Otherwise no promotion.
 */
export function decideLastFramePromotion(
  media: readonly MediaFileBytes[],
): LastFramePromotionDecision {
  let newestSnapshot: MediaFileBytes | undefined
  let lastFrame: MediaFileBytes | undefined
  let newestKeyFrameSmall: MediaFileBytes | undefined
  for (const m of media) {
    if (m.kind === 'snapshot') {
      if (newestSnapshot === undefined || m.timestamp > newestSnapshot.timestamp) {
        newestSnapshot = m
      }
    } else if (m.kind === 'lastFrame') {
      // Single-instance kind — at most one, but guard defensively by keeping
      // the newest should a legacy duplicate linger.
      if (lastFrame === undefined || m.timestamp > lastFrame.timestamp) lastFrame = m
    } else if (m.kind === 'keyFrameSmall') {
      if (newestKeyFrameSmall === undefined || m.timestamp > newestKeyFrameSmall.timestamp) {
        newestKeyFrameSmall = m
      }
    }
  }
  if (newestSnapshot === undefined) {
    // Short-track fallback: no snapshot ever appended AND no lastFrame rolled →
    // copy the keyFrameSmall full frame (when one landed) into the empty slot.
    if (lastFrame === undefined && newestKeyFrameSmall !== undefined) {
      return {
        promote: true,
        mode: 'copy',
        snapshotMediaId: newestKeyFrameSmall.mediaId,
        snapshotTimestamp: newestKeyFrameSmall.timestamp,
      }
    }
    // No snapshot, no keyFrameSmall. With no lastFrame either, the track closes
    // WITHOUT a last view and the cause is one level up — the key frame. Naming
    // it here is what lets the close log a cause instead of a silence.
    return {
      promote: false,
      declinedBecause: lastFrame === undefined ? 'no-key-frame' : 'no-source',
    }
  }
  // A lastFrame already at least as new as the newest snapshot → already last.
  if (lastFrame !== undefined && newestSnapshot.timestamp <= lastFrame.timestamp) {
    return { promote: false, declinedBecause: 'already-last' }
  }
  return {
    promote: true,
    mode: 'move',
    snapshotMediaId: newestSnapshot.mediaId,
    snapshotTimestamp: newestSnapshot.timestamp,
  }
}
