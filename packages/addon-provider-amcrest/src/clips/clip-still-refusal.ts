/**
 * What an Amcrest still-mint says when it produced no bytes — and whether the
 * caller should come back for it.
 *
 * Deliberately the same SHAPE as the Reolink and Hikvision modules of this
 * name, because the three feed one cap enum and one surface, and a second idea
 * of what a still refusal is would be a second thing to keep in step. What
 * differs is which codes can DEFER, and that difference is not a preference:
 *
 * - `queue-full` defers. A mint costs this camera
 *   1 388–2 313 ms of its shared replay budget (`clip-still.ts`), so an ask
 *   that arrives while a playback holds the lane — or one an operator's tap
 *   EVICTED mid-replay — is queued, not failed, and the tile is told to come
 *   back. Under two seconds is worth coming back for.
 * - `camera-backoff` is deferred too: this camera failed its last replays
 *   in a row and its stills are paused for a few minutes
 *   (`clip-still-guard.ts`). Nothing is wrong with the clip; the camera is
 *   being left alone, and the tile is told when to come back.
 * - `sleeping` and `uid-missing` are NOT here. These cameras are mains-powered
 *   and are never hub children.
 *
 * ## Why there is no code → disposition table
 *
 * A table is a second authority, and it is the one a new code forgets to join.
 * The two constructors are typed so the wrong pairing does not compile, and
 * `FinalStillCode` is an `Exclude`, so a code added to the cap enum lands in
 * {@link refuseStill}'s domain automatically and a branch has to opt INTO
 * deferring it.
 */
import type { ClipStillDisposition, ClipStillRefusalCode } from '@camstack/types'

/** The mint is queued behind the camera's one replay, or the camera is
 *  resting. It is coming. */
export type DeferredStillCode = 'queue-full' | 'camera-backoff'

/** Everything else. No retry within this tile's life can change the answer. */
export type FinalStillCode = Exclude<ClipStillRefusalCode, DeferredStillCode>

export interface MintRefusal {
  readonly ok: false
  readonly code: ClipStillRefusalCode
  readonly disposition: ClipStillDisposition
  /** The prose, verbatim — a `camera-refused` is only ever explained by the
   *  camera's own words. Two fields, and two headers, because they were one
   *  and the surface's table was keyed on the bare token. */
  readonly reason: string
  /** Only on a `deferred` refusal. COARSE: the client floors it with its own
   *  backoff and caps its own attempts. */
  readonly retryAfterMs?: number
}

/**
 * The caller went away (its request closed) while the mint waited for the
 * camera's queue. Not a refusal: nobody is left to tell, nothing was dialled,
 * and no refusal code describes it — so it carries none.
 */
export interface MintAbandoned {
  readonly ok: false
  readonly abandoned: true
  readonly waitedMs: number
}

export type MintResult = { readonly ok: true; readonly bytes: Buffer } | MintRefusal | MintAbandoned

/** "You are in the queue." */
export function deferStill(
  code: DeferredStillCode,
  reason: string,
  retryAfterMs: number,
): MintRefusal {
  return { ok: false, code, disposition: 'deferred', reason, retryAfterMs }
}

/** "This will not happen." */
export function refuseStill(code: FinalStillCode, reason: string): MintRefusal {
  return { ok: false, code, disposition: 'final', reason }
}
