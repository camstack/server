/**
 * The plausibility bar a stationary BIRTH must clear — the ARTIFACT rule, and
 * only that.
 *
 * ## What this file no longer does, and why
 *
 * From 2026-09-15 (D497) to 2026-09-16 it also refused a birth on AREA
 * (`BIRTH_MAX_AREA_FRAC`, 0.30 of the frame) and then re-admitted an oversize
 * box on the SHARE of its evidence that came from the periodic occupancy
 * burst. Both are gone, for measured reasons:
 *
 *  - The area bar separated nothing. The operator's own parked car on device
 *    102 measures 0.360 of the frame; the dawn "envelope exploded" ghost that
 *    motivated the bar measured 0.361. Twelve refusals in twelve hours were
 *    the car, in a band nine thousandths wide.
 *  - The burst door was built on a mislabel. The runner filed every LIVE
 *    session frame as `'burst'` and only the pre-roll history as `'session'`
 *    (d946ce42e, 2026-09-14 → 2026-09-16), so "99.5 % burst" described a car
 *    seen at five frames a second in an open session, and the door admitted
 *    any oversize box with a hundred agreements — the 3836 jacket included,
 *    had it been ten centimetres shorter.
 *
 * The damage an oversize ENTRY does was never its size; it was its REACH. An
 * entry at a third of the frame read every much-smaller contained box as a
 * "fragment" of itself and swallowed a genuinely different parked motorcycle
 * (D495's loss). That is answered where the reach is decided: at or above
 * `OVERSIZE_AREA_FRAC` (`stationary-match.ts`) an entry holds a detection on a
 * STRONG read only — no jitter hold, no fragment hold — exactly as the
 * scene-sized SUV on 3829 always has. Measured on 102 between 03:26 and 06:50
 * on 2026-09-16, with the 0.353 car as the only entry: 1 717 detections
 * absorbed, `continuable: 0` — every read of an oversize parked car is strong,
 * so the object loses nothing by being held that way.
 *
 * So a birth is refused for ONE reason: the box is an artifact — near
 * full-frame, or spanning a whole frame dimension. 3836's jacket on its coat
 * stand (1132x1396 in a 1440-high frame, 97 % of the height, 40 486
 * agreements) is refused by this rule and by nothing else, and that is right:
 * forty thousand confirmations of a wrong box are a wrong box. The rule is
 * asked INSIDE the evidence verdict (`evaluateStationaryEvidence`), so a
 * refused candidate keeps its evidence instead of being forgotten and
 * re-accumulated every half hour.
 */

import { isPlausibleThumbnailBox, type ThumbnailGuardBox } from '../../best-thumbnail-guard.js'

/** The box shape the birth bar needs. */
export interface BirthGuardBox extends ThumbnailGuardBox {
  readonly w: number
  readonly h: number
}

/** Area of `bbox` as a fraction of the frame. 0 when the frame is unknown —
 *  a fraction of nothing is not a measurement (D393). Kept for the birth log
 *  line, where "how big" is a fact worth reading even though it decides
 *  nothing. */
export function boxAreaFraction(
  bbox: BirthGuardBox,
  frameWidth: number,
  frameHeight: number,
): number {
  if (frameWidth <= 0 || frameHeight <= 0) return 0
  return (bbox.w * bbox.h) / (frameWidth * frameHeight)
}

/**
 * True when `bbox` may become a stationary entry.
 *
 * The near-full-frame / full-dimension artifact rules of the thumbnail guard,
 * asked WITHOUT a score: the dawn envelope explodes with a confident score,
 * and `NEAR_FULL_FRAME_CONFIDENT_SCORE` exists to save a thumbnail for a
 * track, not to mint a durable row. Degenerate frame dimensions (≤0) are
 * plausible — there is no measurement to refuse on.
 */
export function isPlausibleStationaryBirthBox(
  bbox: BirthGuardBox,
  frameWidth: number,
  frameHeight: number,
): boolean {
  if (frameWidth <= 0 || frameHeight <= 0) return true
  return isPlausibleThumbnailBox(bbox, frameWidth, frameHeight)
}
