import { describe, it, expect } from 'vitest'
import { isRiderPair, pairRiders, riderSubjectBox, type RiderCandidate } from '../rider-pairing.js'

/**
 * The reference case, measured by running the detector on the real media of
 * device 102 track `9eaa0320` — a cyclist crossing the frame at 1280x720.
 */
const CYCLIST: RiderCandidate = {
  id: 'p1',
  macroClass: 'person',
  bbox: { x: 1122, y: 204, w: 70, h: 164 },
  score: 0.72,
}
const BICYCLE: RiderCandidate = {
  id: 'v1',
  macroClass: 'vehicle',
  originalClass: 'bicycle',
  bbox: { x: 1112, y: 271, w: 79, h: 139 },
  score: 0.572,
}
/** The parked car in the same frame — the distractor that must never pair. */
const PARKED_CAR: RiderCandidate = {
  id: 'v2',
  macroClass: 'vehicle',
  originalClass: 'car',
  bbox: { x: 278, y: 58, w: 497, h: 516 },
  score: 0.955,
}

describe('isRiderPair', () => {
  it('pairs the measured cyclist with the measured bicycle', () => {
    expect(isRiderPair(CYCLIST, BICYCLE)).toBe(true)
  })

  it('NEVER pairs a person with a car, however much they overlap', () => {
    const personOnCar: RiderCandidate = {
      ...CYCLIST,
      bbox: { x: 300, y: 100, w: 70, h: 164 },
    }
    expect(isRiderPair(personOnCar, PARKED_CAR)).toBe(false)
  })

  it('pairs a motorcycle and a motorbike, not only a bicycle', () => {
    for (const originalClass of ['motorcycle', 'motorbike', 'Bicycle']) {
      expect(isRiderPair(CYCLIST, { ...BICYCLE, originalClass })).toBe(true)
    }
  })

  it('rejects a pedestrian walking IN FRONT of a bike — centre below it', () => {
    // Same overlap, but the person's centre sits LOWER than the machine's, so
    // they are beside/before it rather than on it.
    const walker: RiderCandidate = { ...CYCLIST, bbox: { x: 1122, y: 330, w: 70, h: 164 } }
    expect(isRiderPair(walker, BICYCLE)).toBe(false)
  })

  it('rejects a person who merely grazes the bike', () => {
    const grazing: RiderCandidate = { ...CYCLIST, bbox: { x: 1180, y: 204, w: 70, h: 164 } }
    expect(isRiderPair(grazing, BICYCLE)).toBe(false)
  })

  it('rejects the reversed roles — a vehicle is not a rider', () => {
    expect(isRiderPair(BICYCLE, CYCLIST)).toBe(false)
  })

  it('survives a degenerate box instead of dividing by zero', () => {
    const empty: RiderCandidate = { ...CYCLIST, bbox: { x: 1122, y: 204, w: 0, h: 0 } }
    expect(isRiderPair(empty, BICYCLE)).toBe(false)
  })
})

describe('pairRiders', () => {
  it('pairs the cyclist and leaves the parked car alone', () => {
    const pairs = pairRiders([CYCLIST, BICYCLE, PARKED_CAR])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ personId: 'p1', vehicleId: 'v1' })
    expect(pairs[0]!.overlap).toBeGreaterThan(0.5)
  })

  it('returns nothing when there is no two-wheeler in the frame', () => {
    expect(pairRiders([CYCLIST, PARKED_CAR])).toEqual([])
  })

  it('returns nothing for a bike with no rider — a parked bicycle stays a vehicle', () => {
    expect(pairRiders([BICYCLE, PARKED_CAR])).toEqual([])
  })

  it('never lets two bikes claim the same rider', () => {
    const secondBike: RiderCandidate = { ...BICYCLE, id: 'v3' }
    const pairs = pairRiders([CYCLIST, BICYCLE, secondBike])
    expect(pairs).toHaveLength(1)
  })

  it('pairs each of two riders with their own machine', () => {
    const rider2: RiderCandidate = { ...CYCLIST, id: 'p2', bbox: { x: 500, y: 204, w: 70, h: 164 } }
    const bike2: RiderCandidate = { ...BICYCLE, id: 'v9', bbox: { x: 490, y: 271, w: 79, h: 139 } }
    const pairs = pairRiders([CYCLIST, rider2, BICYCLE, bike2])
    expect(pairs).toHaveLength(2)
    expect(new Set(pairs.map((p) => p.vehicleId))).toEqual(new Set(['v1', 'v9']))
  })
})

/**
 * D407 — the folded subject's BOX.
 *
 * The fold makes the rider and the machine ONE subject; until 2026-09-08 the
 * box that survived it was the MACHINE's alone, so every crop cut from it left
 * the rider outside. Operator, device 102, two notes three minutes apart
 * (tracks `7f50622b` and `9cbc4791`): "veicoli a due ruote devono includere la
 * persona nel keyframe" [two-wheeled vehicles must include the person in the keyframe].
 */
describe('riderSubjectBox', () => {
  it('is the union of the rider and the machine — the rider is INSIDE it', () => {
    const box = riderSubjectBox(CYCLIST.bbox, BICYCLE.bbox)
    // Measured cyclist: person y 204..368, bike y 271..410, x 1112..1192.
    expect(box).toEqual({ x: 1112, y: 204, w: 80, h: 206 })
    // The contract, stated as containment rather than as four numbers.
    expect(box.x).toBeLessThanOrEqual(CYCLIST.bbox.x)
    expect(box.y).toBeLessThanOrEqual(CYCLIST.bbox.y)
    expect(box.x + box.w).toBeGreaterThanOrEqual(CYCLIST.bbox.x + CYCLIST.bbox.w)
    expect(box.y + box.h).toBeGreaterThanOrEqual(CYCLIST.bbox.y + CYCLIST.bbox.h)
  })

  it('still contains the MACHINE — the fold widens the subject, never moves it', () => {
    const box = riderSubjectBox(CYCLIST.bbox, BICYCLE.bbox)
    expect(box.x).toBeLessThanOrEqual(BICYCLE.bbox.x)
    expect(box.y).toBeLessThanOrEqual(BICYCLE.bbox.y)
    expect(box.x + box.w).toBeGreaterThanOrEqual(BICYCLE.bbox.x + BICYCLE.bbox.w)
    expect(box.y + box.h).toBeGreaterThanOrEqual(BICYCLE.bbox.y + BICYCLE.bbox.h)
  })
})
