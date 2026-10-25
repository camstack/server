/**
 * "Was this person born on top of a parked car?" — the question, as a pure
 * predicate, so the phantom rate is a number instead of an impression.
 *
 * ## This does not suppress anything, and it must not
 *
 * A person standing at, leaning on, or getting out of a car is a real person,
 * and on a driveway camera that is most of the people it will ever see.
 * Suppressing the overlap would delete the detections the system exists for.
 * D275 made exactly this call for stationary objects: the geometry is evidence,
 * never a veto.
 *
 * So the predicate is used ONLY to attribute a counter
 * (`FAMILY_PERSON_BIRTH` / `REASON_PERSON_OVER_VEHICLE`). Hand-counted on
 * 2026-08-28: 4 of 23 person tracks on camera 102 in two hours. That ratio is
 * what a change has to move, and nothing recorded it.
 *
 * ## Containment, not IoU
 *
 * IoU is the wrong measure here and would find nothing: a person box inside a
 * car box has a small intersection over their UNION, because the car is much
 * larger. What separates a phantom from a real pedestrian is that the person
 * box is almost entirely INSIDE the vehicle box — intersection over the
 * PERSON's own area. {@link CONTAINMENT_THRESHOLD} is where that fraction is
 * high enough to be worth counting.
 */

/** A box in frame pixel space. */
export interface PersonOverVehicleBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** One other detection in the same frame. */
export interface PersonOverVehicleNeighbour {
  readonly className: string
  readonly bbox: PersonOverVehicleBox
}

/**
 * How much of the PERSON box must sit inside a vehicle box to be counted.
 *
 * 0.8 and not 1.0: a phantom raised on a car's window pillar or wing mirror
 * routinely pokes a little outside the vehicle box, and requiring total
 * containment would count almost none of them. 0.8 and not 0.5: half a person
 * box overlapping a car is what a pedestrian walking in front of one looks
 * like, and counting those would make the number mean "somebody was near a
 * car", which is not a defect.
 */
const CONTAINMENT_THRESHOLD = 0.8

/**
 * The classes that count as a vehicle for this test.
 *
 * A local list rather than a shared taxonomy on purpose: it exists to describe
 * ONE measurement, and a shared enum would make a change here silently change
 * detection behaviour somewhere else.
 */
export const VEHICLE_CLASSES: readonly string[] = ['car', 'truck', 'bus', 'motorcycle', 'vehicle']

/** Area of the intersection of two boxes. `0` when they do not overlap. */
function intersectionArea(a: PersonOverVehicleBox, b: PersonOverVehicleBox): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (right <= left || bottom <= top) return 0
  return (right - left) * (bottom - top)
}

/**
 * Fraction of `person` that lies inside `vehicle`, in `[0,1]`.
 *
 * `0` for a degenerate person box: a zero-area box is inside everything and
 * inside nothing, and answering `1` would count every one of them.
 */
function containedFraction(person: PersonOverVehicleBox, vehicle: PersonOverVehicleBox): number {
  const area = person.w * person.h
  if (area <= 0) return 0
  return intersectionArea(person, vehicle) / area
}

/**
 * Is this person box contained in any vehicle box in the same frame?
 *
 * Returns the fraction for the BEST-containing vehicle when it clears
 * {@link CONTAINMENT_THRESHOLD}, else `null`. The fraction rides along because
 * a counter that only ever says "yes" cannot later be re-thresholded against
 * what was actually measured.
 */
export function personOverVehicle(
  person: PersonOverVehicleBox,
  neighbours: readonly PersonOverVehicleNeighbour[],
  threshold: number = CONTAINMENT_THRESHOLD,
): number | null {
  let best = 0
  for (const neighbour of neighbours) {
    if (!VEHICLE_CLASSES.includes(neighbour.className)) continue
    const fraction = containedFraction(person, neighbour.bbox)
    if (fraction > best) best = fraction
  }
  return best >= threshold ? best : null
}
