/**
 * What a still-mint says when it produced no bytes — and whether the caller
 * should come back for it.
 *
 * The mint route has always answered 204 with a reason. What it could not say
 * was whether the reason was about NOW or about ever, and the surface latched
 * both: with one CoverPreview in flight per host and a 16-deep lane, a
 * measured 43 of 60 tiles on one page of camera 107 answered `queue-full` on a
 * parallel first paint (2026-09-20) and every one of them stayed blank for a
 * still that was seconds away.
 *
 * ## Why there is no code → disposition table
 *
 * A table is a second authority, and it is the one a new code forgets to join.
 * Instead the two constructors are typed so narrowly that the wrong pairing
 * does not compile: {@link deferStill} accepts only the codes that mean "the
 * still is still coming", {@link refuseStill} only the ones that mean "it is
 * not", and `FinalStillCode` is an `Exclude` — so a code added to the cap enum
 * lands in `refuseStill`'s domain automatically and a branch has to opt INTO
 * deferring it.
 */
import type { ClipStillDisposition, ClipStillRefusalCode } from '@camstack/types'

/** The stills that are merely waiting: the work is queued, or the host is
 *  resting after a refusal and only an interactive request may probe it. */
export type DeferredStillCode = 'queue-full' | 'camera-backoff'

/** Everything else. No retry within this tile's life can change the answer. */
export type FinalStillCode = Exclude<ClipStillRefusalCode, DeferredStillCode>

/**
 * A mint that did not produce bytes.
 *
 * `code` is the token a surface may key words on; `reason` is the prose, kept
 * verbatim, because a `camera-refused` is only ever explained by the camera's
 * own words. They are two fields — and, on the wire, two headers — because
 * they were one: the route sent `queue-full: 16 thumbnail mints already
 * waiting for host …` and the surface's table was keyed by the bare token, so
 * every refusal on this fleet rendered as `Refused: <prose>`.
 */
export interface MintRefusal {
  readonly ok: false
  readonly code: ClipStillRefusalCode
  readonly disposition: ClipStillDisposition
  readonly reason: string
  /** Only on a `deferred` refusal: how long before asking again is worth it.
   *  A COARSE hint — the client floors it with its own backoff and caps its
   *  own attempts, so a wrong hint can neither cause a hammer nor a hang. */
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

/**
 * The queue's own refusal — the only failure that is about the LANE rather
 * than about the camera, and therefore the only one that is deferred.
 *
 * It carries its own `retryAfterMs` because the queue is the only thing that
 * knows it: the depth it is holding, or the exact instant a host's backoff
 * closes.
 */
export class ThumbQueueRefusedError extends Error {
  readonly code: DeferredStillCode
  readonly retryAfterMs: number

  constructor(code: DeferredStillCode, message: string, retryAfterMs: number) {
    super(message)
    this.name = 'ThumbQueueRefusedError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * A thrown value from the queue, as a wire answer — or `null` when it was not
 * the queue at all.
 *
 * `null` is not a default: it is what makes the caller name `camera-refused`
 * explicitly, instead of a socket close quietly inheriting "come back later"
 * and a tile retrying four times against a camera that is not there.
 */
export function queueRefusal(err: unknown): MintRefusal | null {
  if (!(err instanceof ThumbQueueRefusedError)) return null
  return deferStill(err.code, err.message, err.retryAfterMs)
}
