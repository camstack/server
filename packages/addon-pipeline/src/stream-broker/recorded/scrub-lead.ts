/**
 * How far ahead of the finger a scrub read may aim — and when aiming at all
 * stops being sensible.
 *
 * Extracted as a pure function because the decision could not be tested where
 * it lived. The feeder's drag harness drives pointer samples through microtask
 * flushes, so wall-clock gaps are ~0, below `SCRUB_VELOCITY_MIN_GAP_MS`, and
 * the velocity estimate never updates: an integration test asserting on the
 * ceiling passed VACUOUSLY, with the lead at 0 because no velocity existed.
 * That is the shape this repo keeps paying for — a green assertion that could
 * not have failed.
 */

/**
 * Ceiling on the lead, in ms of TIMELINE.
 *
 * `velocity × readMs` is dimensionally right and was unbounded. On a day-wide
 * timeline 83 px/s is ~2.5 HOURS of timeline per second, so "where the finger
 * will be in 246 ms" is fourteen minutes away — measured on the operator's own
 * drag 2026-08-26: `leadMsP50` 840 692, `leadMsMax` 3 395 591, with 20
 * speculative reads buying 5 hits while 12 cold reads at 246 ms each were what
 * the gesture was actually blocked on.
 *
 * 30 s is three whole-segment read units at the shipped segment length: far
 * enough that a careful or moderate drag keeps the lead that produced the
 * measured −55% / −71% staleness, short enough that the aimed read lands in a
 * segment the session cache can still hold when the finger arrives.
 */
export const SCRUB_LEAD_MAX_MS = 30_000

/** What a read should aim at, and whether speculation is worth anything. */
export interface ScrubLeadDecision {
  /** Timeline ms to add to the target. 0 = serve where the finger IS. */
  readonly leadMs: number
  /**
   * The finger is moving faster than a read can chase. Speculation must stop:
   * past the ceiling a prefetch is a random seek for bytes nothing will ask
   * for, queued ahead of the read the operator is blocked on.
   */
  readonly saturated: boolean
}

/**
 * `velocity` is ms of timeline per ms of wall clock, signed. `readMs` is what a
 * read costs on this disk right now. Either being null means "not enough is
 * known to aim" — which is NOT saturation: an unknown velocity must not switch
 * speculation off, or the first ticks of every drag would lose it.
 */
export function scrubLeadDecision(
  velocity: number | null,
  readMs: number | null,
): ScrubLeadDecision {
  if (velocity === null || readMs === null) return { leadMs: 0, saturated: false }
  const raw = Math.round(velocity * readMs)
  if (Math.abs(raw) > SCRUB_LEAD_MAX_MS) return { leadMs: 0, saturated: true }
  return { leadMs: raw, saturated: false }
}
