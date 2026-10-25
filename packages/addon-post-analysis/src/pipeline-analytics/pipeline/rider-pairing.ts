/**
 * Rider pairing — a person ON a two-wheeler is ONE subject, and it is a
 * VEHICLE.
 *
 * ## Why
 *
 * The detector already sees both halves. Measured on device 102, track
 * `9eaa0320`, a cyclist crossing the frame (1280x720):
 *
 *   person   0.720  x=1122 y=204 w=70 h=164
 *   vehicle  0.572  x=1112 y=271 w=79 h=139   ← the bicycle, under the rider
 *
 * Both clear their floors (0.65 / 0.50) and the boxes overlap heavily. Left
 * alone the tracker takes them as two independent subjects, so one passer-by
 * on a bike produces a `person` track AND a `vehicle` track — and which of the
 * two a notification rule sees is decided by whichever detection happens to
 * win association that frame. The operator's call: a cyclist is a VEHICLE, and
 * both entities stay on the record.
 *
 * ## The rule
 *
 * A pair is a rider when all three hold:
 *
 *  1. the vehicle's ORIGINAL (fine) class is a two-wheeler — `originalClass`
 *     survives the macro mapping (`mutable.originalClass = det.class`), so a
 *     person standing beside a CAR can never be mistaken for a rider;
 *  2. a real share of the person's box lies over the vehicle's;
 *  3. the person's centre sits ABOVE the vehicle's — a rider is on top of the
 *     machine. This is what separates a rider from a pedestrian who happens to
 *     walk in front of a parked bike.
 *
 * Pure and RN-free so the geometry is asserted directly against the measured
 * boxes above.
 */

/** Minimal box shape — pixel space, same frame. */
export interface RiderBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface RiderCandidate {
  readonly id: string
  readonly macroClass: string
  /** COCO/fine class before the macro mapping (`bicycle`, `car`, …). */
  readonly originalClass?: string
  readonly bbox: RiderBox
  readonly score: number
}

/**
 * Fine classes that carry a rider. A scooter/moped reaches us as
 * `motorcycle` (COCO) or `motorbike` depending on the model's label set.
 */
const TWO_WHEELERS: ReadonlySet<string> = new Set(['bicycle', 'motorcycle', 'motorbike'])

/**
 * Minimum share of the PERSON's box that must lie over the two-wheeler.
 *
 * Measured on the reference cyclist: 58%. Set well below that — a rider seen
 * from the side, or one standing on the pedals, overlaps far less — but high
 * enough that a pedestrian merely passing a parked bike does not qualify.
 */
const RIDER_MIN_PERSON_OVERLAP = 0.25

export interface RiderPair {
  readonly personId: string
  readonly vehicleId: string
  /** Share of the person's box over the vehicle's, for the log. */
  readonly overlap: number
}

/** Intersection area of two boxes. */
function intersection(a: RiderBox, b: RiderBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y
}

/**
 * The FOLDED subject's box: the union of the rider and the machine.
 *
 * The fold's whole claim is that the two halves are ONE subject. Until
 * 2026-09-08 the box that survived the fold was the MACHINE's alone, so every
 * consumer that cuts pixels from `TrackedDetectionOut.bbox` — the best-shot
 * thumbnail, `wideCentralSquareLayout`'s central square, the close-time
 * keyFrame→thumbnail derive — framed a motorcycle with its rider's head cut
 * off. Operator, device 102, tracks `7f50622b` and `9cbc4791`, three minutes
 * apart: "motocicli e veicoli a due ruote devono includere il conducente nel
 * keyframe" [motorcycles and two-wheeled vehicles must include the rider in the keyframe] (D407).
 *
 * This is the ONE place the folded subject's rectangle is formed, and it is
 * formed BEFORE the tracker — so no crop path derives a second rectangle
 * (D52 stays intact: `deriveDetailCropRect` is still the only detail-crop
 * derivation, and it now receives a subject box that already holds the rider).
 * Pure geometry: a strict union, never a pad — the fold widens the subject, it
 * never moves it.
 */
export function riderSubjectBox(person: RiderBox, vehicle: RiderBox): RiderBox {
  const x = Math.min(person.x, vehicle.x)
  const y = Math.min(person.y, vehicle.y)
  const right = Math.max(person.x + person.w, vehicle.x + vehicle.w)
  const bottom = Math.max(person.y + person.h, vehicle.y + vehicle.h)
  return { x, y, w: right - x, h: bottom - y }
}

/** True when `vehicle` is a two-wheeler that `person` is riding. */
export function isRiderPair(person: RiderCandidate, vehicle: RiderCandidate): boolean {
  if (person.macroClass !== 'person') return false
  if (vehicle.macroClass !== 'vehicle') return false
  if (!TWO_WHEELERS.has((vehicle.originalClass ?? '').toLowerCase())) return false
  const personArea = person.bbox.w * person.bbox.h
  if (!(personArea > 0)) return false
  if (intersection(person.bbox, vehicle.bbox) / personArea < RIDER_MIN_PERSON_OVERLAP) return false
  // A rider sits ON the machine: their box centre is higher up the frame.
  const personCentreY = person.bbox.y + person.bbox.h / 2
  const vehicleCentreY = vehicle.bbox.y + vehicle.bbox.h / 2
  return personCentreY < vehicleCentreY
}

/**
 * Pair every rider with their machine. A person is paired at most once — with
 * the two-wheeler they overlap MOST — so two bikes side by side cannot both
 * claim the same rider.
 */
export function pairRiders(detections: readonly RiderCandidate[]): readonly RiderPair[] {
  const people = detections.filter((d) => d.macroClass === 'person')
  const twoWheelers = detections.filter(
    (d) => d.macroClass === 'vehicle' && TWO_WHEELERS.has((d.originalClass ?? '').toLowerCase()),
  )
  if (people.length === 0 || twoWheelers.length === 0) return []

  const pairs: RiderPair[] = []
  const claimed = new Set<string>()
  for (const person of people) {
    let best: { vehicle: RiderCandidate; overlap: number } | null = null
    const personArea = person.bbox.w * person.bbox.h
    if (!(personArea > 0)) continue
    for (const vehicle of twoWheelers) {
      if (claimed.has(vehicle.id)) continue
      if (!isRiderPair(person, vehicle)) continue
      const overlap = intersection(person.bbox, vehicle.bbox) / personArea
      if (!best || overlap > best.overlap) best = { vehicle, overlap }
    }
    if (best) {
      claimed.add(best.vehicle.id)
      pairs.push({
        personId: person.id,
        vehicleId: best.vehicle.id,
        overlap: Math.round(best.overlap * 1000) / 1000,
      })
    }
  }
  return pairs
}
