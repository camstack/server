/**
 * What a Hikvision still-mint says when it produced no bytes — and whether the
 * caller should come back for it.
 *
 * Deliberately the same SHAPE as the Reolink module of this name, because the
 * two feed one cap enum and one surface, and a second idea of what a still
 * refusal is would be a second thing to keep in step. What differs is which
 * codes can DEFER, and that difference is not a preference:
 *
 * - `queue-full` is the only deferred code here. A Hikvision still is cut from
 *   the clip's own archived MP4, and when the archive is not held yet the mint
 *   has to pay the camera's one replay slot — so an ask that arrives while
 *   somebody's playback holds it is queued, not failed, and the tile is told
 *   to come back.
 * - `camera-backoff` is NOT here. It arms on Reolink's `resp_code=400`, a
 *   refusal shape this firmware does not produce; copying the code with a
 *   predicate that can never match would be the leftover that describes a
 *   design this addon does not have.
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

/** The still is queued behind the camera's one replay slot. It is coming. */
export type DeferredStillCode = 'queue-full'

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

export type MintResult = { readonly ok: true; readonly bytes: Buffer } | MintRefusal

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
