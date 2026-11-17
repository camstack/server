/**
 * Short-motionless close — the scenery re-fire that Events must not show.
 *
 * A parked plate, a garage doorframe, a bush: they confirm, live 2–13 s, and
 * die with a walk of a few pixels of bbox jitter. They are too brief and too
 * few to accumulate the repeated evidence a stationary ENTRY needs, so nothing
 * suppresses them. Events reads `listRecentTracks`, which hides only
 * `closedReason = stationary-promotion`. Stamping that reason on THIS class of
 * close is what keeps the six 102/3829 re-fires out of the gallery.
 *
 * Net displacement, not walk: `1e073359` walked 6 px of jitter and was labelled
 * moving; its start→end net was 0.5 px. Walk is the wrong "did it go anywhere".
 *
 * The pixel ceiling is class-specific. 40 px is bbox jitter on a standing
 * *person* (9310d1ff: 9.7 s, 30 px). The same ceiling on a vehicle hides a
 * real car whose Events path and crop were the car (86918072: 10.9 s, net
 * 15 px, walk 435). Parked-plate flashes stay under the original 8 px.
 */

/** Brackets the observed plant / parked-plate tracks (3.8–19.0 s). */
export const SHORT_TRACK_MAX_MS = 25_000
/** Person net start→end under this is "did not move" (bbox jitter). */
export const MOTIONLESS_MAX_PX = 40
/** Vehicle / other classes: the original parked-plate ceiling. */
const VEHICLE_MOTIONLESS_MAX_PX = 8

const VEHICLE_CLASSES: ReadonlySet<string> = new Set(['vehicle', 'car', 'truck', 'bus'])

/**
 * A short motionless PERSON is stamped and persisted, never discarded (D547).
 *
 * The discard exists for re-sightings of an OBJECT an entity represents — a
 * parked car the registry censuses in two sessions, a plate flash on it. No
 * entity ever represents a person who stood still for ten seconds (the person
 * policy needs thirty minutes of agreement, on purpose), and the face read
 * such a track holds is the only record of who was there. Deleting the track
 * would delete that; hiding the row from the feed was always the whole rule.
 */
export function isDiscardExemptClass(className: string): boolean {
  return className.toLowerCase() === 'person'
}

function motionlessMaxPxForClass(className: string): number {
  return VEHICLE_CLASSES.has(className.toLowerCase())
    ? VEHICLE_MOTIONLESS_MAX_PX
    : MOTIONLESS_MAX_PX
}

export function netDisplacementPx(
  positions: readonly { readonly x: number; readonly y: number }[],
): number {
  const first = positions[0]
  const last = positions[positions.length - 1]
  if (!first || !last) return 0
  return Math.hypot(last.x - first.x, last.y - first.y)
}

/**
 * The least life a track needs before "it did not move" means anything.
 *
 * The rule above was calibrated on scenery re-fires that lived 3.8–19.0 s
 * (the shortest live flash it was checked against: 1.6 s). Without a floor it
 * also judged tracks it was never shown: camera 1441, 2026-11-17, a walker
 * (`gfygqn22cf`) seen for 387 ms on 2 observations had a net displacement
 * under 40 px because there was no time to cover more — and was hidden from
 * the feed as scenery. Under 1.5 s a walking person covers roughly a metre,
 * which on a wide camera is a few pixels: "short" and "motionless" cannot be
 * told apart, so nothing is concluded.
 */
export const SHORT_MOTIONLESS_MIN_LIFE_MS = 1_500

/**
 * The fewest observations "net displacement" is measured on. Two points are a
 * single step — their difference is bbox jitter or one stride, whichever
 * happened; four give three steps, the least a stillness reading rests on. A
 * scenery re-fire in the calibration set (2–19 s at the detection rate) holds
 * far more than four.
 */
export const SHORT_MOTIONLESS_MIN_OBSERVATIONS = 4

/**
 * What a closing track's life says about it:
 *  - `motionless` — a short scenery re-fire (stamped, hidden from Events);
 *  - `moving` — it lived past the window or went somewhere;
 *  - `too-brief` — under the minimum life or observations: no conclusion, the
 *    track closes as a normal track and arms or clears nothing.
 */
export type ShortMotionlessVerdict = 'motionless' | 'moving' | 'too-brief'

export function shortMotionlessVerdict(
  lifeMs: number,
  movedPx: number,
  className: string,
  observations: number,
): ShortMotionlessVerdict {
  if (lifeMs > SHORT_TRACK_MAX_MS || movedPx > motionlessMaxPxForClass(className)) return 'moving'
  if (lifeMs < SHORT_MOTIONLESS_MIN_LIFE_MS || observations < SHORT_MOTIONLESS_MIN_OBSERVATIONS) {
    return 'too-brief'
  }
  return 'motionless'
}
