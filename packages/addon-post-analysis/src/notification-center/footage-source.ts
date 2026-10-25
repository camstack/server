/**
 * WHICH SOURCE a notification's footage is cut from — one pure decision, one
 * place. The companion to `media-anchor.ts`: that module decides WHICH MOMENT
 * the window is about, this one decides who can still serve that moment.
 *
 * ## The rule
 *
 * **The ring when the moment is still inside it, the recordings when it is
 * not.** Nothing else. The broker's clip ring is a warm, already-decoded
 * pre-buffer of the last `ringRetentionSec` seconds — the retention that
 * camera's own rules asked for (`clip-retention-ask.ts`), never a global
 * constant: when
 * the window fits in it the cut is cheap and instant, and asking the recorder
 * instead would queue an ffmpeg render for footage we already hold.
 *
 * ## It is about the MOMENT, not about the kind of notification
 *
 * Deliberately so, and this is the whole reason the decision is its own
 * function. An occupancy departure is the case that made the problem visible —
 * confirmed by an independent read minutes after the fact (D279), measured 6–10
 * minutes behind on device 102 — but nothing about it is special. A row that
 * sat in the outbox across a restart, a target that was unreachable for a
 * quarter of an hour, a retry with backoff: every one of them asks for a window
 * the ring no longer holds, for reasons that have nothing to do with occupancy.
 * A rule keyed on the notification KIND would serve the departure and keep
 * failing all the others.
 *
 * ## What "inside the ring" means
 *
 * The oldest instant the cut NEEDS is `anchorMs - preRollSec`, not `anchorMs` —
 * a four-second pre-roll on a twenty-two-second-old moment is already past the
 * ring even though the anchor is not. This is the same arithmetic the
 * dispatcher's own refusal used before there was anywhere else to go, extracted
 * verbatim rather than restated, because a second spelling of it would be free
 * to disagree about the pre-roll.
 *
 * ## Monotone on purpose
 *
 * The answer only ever moves from `ring` to `recordings` as the clock advances,
 * never back: a row retried later can conclude `recordings` where its first
 * attempt concluded `ring`, never `ring` for a window the ring has already
 * dropped. The dispatcher asks ONCE per attempt and the recorded cut runs on
 * that answer, inside the same delivery (D686).
 */

/** Where a cut can come from. */
export type NcFootageSource = 'ring' | 'recordings'

/** Everything the decision reads. No clock, no I/O — the caller supplies both. */
export interface NcFootageSourceInput {
  /** The instant the window is centred on — `NcMediaAnchor.atMs`. */
  readonly anchorMs: number
  readonly nowMs: number
  readonly preRollSec: number
  /** How many seconds the broker's clip ring retains. */
  readonly ringRetentionSec: number
}

/**
 * Decide where this window must be cut from. Pure and total.
 *
 * A non-finite or future anchor answers `ring`: an unmeasurable age is not a
 * reason to queue an ffmpeg render, and the ring refusing on its own terms is
 * a cheaper and more honest failure than a recorder asked about a moment
 * nobody can name (D393 — a measurement that failed is not a number to reason
 * from).
 */
export function footageSourceFor(input: NcFootageSourceInput): NcFootageSource {
  const { anchorMs, nowMs, preRollSec, ringRetentionSec } = input
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs)) return 'ring'
  const ageSec = (nowMs - anchorMs) / 1000
  if (!Number.isFinite(ageSec)) return 'ring'
  return ageSec + preRollSec > ringRetentionSec ? 'recordings' : 'ring'
}
