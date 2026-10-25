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

export function isShortMotionlessTrack(
  lifeMs: number,
  movedPx: number,
  className: string,
): boolean {
  return lifeMs <= SHORT_TRACK_MAX_MS && movedPx <= motionlessMaxPxForClass(className)
}
