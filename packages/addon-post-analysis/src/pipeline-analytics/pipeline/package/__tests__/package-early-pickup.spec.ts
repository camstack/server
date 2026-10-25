/**
 * Early pick-up on POSITIVE evidence (D687, per-camera opt-in, default off).
 *
 * 101, 2026-09-30: the parcel was last seen at 15:23:19. The collector was in
 * the zone at 15:23:20, and the package step looked at an empty, unoccluded
 * doormat at 15:23:29, :37 and :42. The pick-up was nonetheless concluded at
 * 15:28:36, five minutes of TTL later. With the rule on, it would have been
 * concluded at the third read.
 *
 * The rule: at least three independent absence reads spanning at least 10 s
 * (unoccluded looks that found no box at the parcel's place), after its last
 * sighting, and somebody in the drop-off zone around the disappearance. One
 * contradicting read never destroys the entry (D49). Pure silence keeps the
 * 300 s TTL.
 */

import { describe, expect, it } from 'vitest'
import { PACKAGE_DROP_DEFAULTS, resolvePackageDropSettings } from '../../../package-settings.js'
import {
  PACKAGE_EARLY_PICKUP_MIN_READS,
  PACKAGE_EARLY_PICKUP_MIN_SPAN_MS,
  type PackageSighting,
  type PackageStillnessInput,
  PackageStillnessTracker,
} from '../package-stillness-tracker.js'

const DEVICE = 101
const DOORMAT = { x: 104.5, y: 164.4, w: 271, h: 78 }
const START = 10_000_000
const LAST_SEEN = START + 800
/** The collector, in the zone just after the last sighting. */
const COLLECTOR_AT = LAST_SEEN + 1_000
const parcel: PackageSighting = { className: 'package', bbox: DOORMAT }

function makeTracker(): PackageStillnessTracker {
  let n = 0
  return new PackageStillnessTracker({ newId: () => `cand-${(n += 1)}` })
}

function frame(
  t: PackageStillnessTracker,
  timestamp: number,
  over: Partial<PackageStillnessInput> = {},
): ReturnType<PackageStillnessTracker['observe']> {
  return t.observe({
    deviceId: DEVICE,
    sightings: [],
    frameWidth: 640,
    frameHeight: 360,
    timestamp,
    minDwellMs: 0,
    activityWindowMs: 300_000,
    lastActivityAt: COLLECTOR_AT,
    earlyPickup: true,
    rawPackageBoxes: [],
    ...over,
  })
}

function deliver(t: PackageStillnessTracker): string {
  const courier = { lastActivityAt: START }
  frame(t, START, { sightings: [parcel], looked: true, ...courier })
  frame(t, START + 400, { sightings: [parcel], looked: true, ...courier })
  const out = frame(t, LAST_SEEN, { sightings: [parcel], looked: true, ...courier })
  const id = out.promoted[0]?.id
  if (id === undefined) throw new Error('fixture: the parcel did not promote')
  return id
}

describe('early pick-up (D687)', () => {
  it('concludes on the third unoccluded empty look spanning 10 s, with the collector around', () => {
    const t = makeTracker()
    const id = deliver(t)
    expect(frame(t, LAST_SEEN + 10_000, { looked: true }).departed).toHaveLength(0)
    expect(frame(t, LAST_SEEN + 15_000, { looked: true }).departed).toHaveLength(0)
    const out = frame(t, LAST_SEEN + 20_000, { looked: true })
    expect(out.departed.map((e) => e.id)).toEqual([id])
    expect(out.earlyDepartureIds).toEqual([id])
    expect(t.debugCandidateCount(DEVICE)).toBe(0)
  })

  it('is OFF unless the camera opts in — the TTL alone decides', () => {
    const t = makeTracker()
    deliver(t)
    for (const dt of [10_000, 15_000, 20_000, 25_000]) {
      expect(frame(t, LAST_SEEN + dt, { looked: true, earlyPickup: false }).departed).toHaveLength(
        0,
      )
    }
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('needs the reads to SPAN 10 s — three looks of one burst second are one moment', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 10_000, { looked: true })
    frame(t, LAST_SEEN + 12_500, { looked: true })
    const out = frame(t, LAST_SEEN + 15_000, { looked: true })
    expect(out.departed).toHaveLength(0)
    expect(PACKAGE_EARLY_PICKUP_MIN_SPAN_MS).toBe(10_000)
  })

  it('needs THREE reads — two empty looks are not agreement', () => {
    expect(PACKAGE_EARLY_PICKUP_MIN_READS).toBe(3)
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 5_000, { looked: true })
    const out = frame(t, LAST_SEEN + 30_000, { looked: true })
    expect(out.departed).toHaveLength(0)
  })

  it('never counts a frame the step did not look at, however empty', () => {
    const t = makeTracker()
    deliver(t)
    for (const dt of [10_000, 15_000, 20_000, 25_000]) {
      expect(frame(t, LAST_SEEN + dt, { looked: false }).departed).toHaveLength(0)
    }
  })

  it('never counts a look whose view of the parcel a person covered', () => {
    const t = makeTracker()
    deliver(t)
    const person = { x: 150, y: 120, w: 120, h: 200 }
    for (const dt of [10_000, 15_000, 20_000, 25_000]) {
      const out = frame(t, LAST_SEEN + dt, { looked: true, occluders: [person] })
      expect(out.departed).toHaveLength(0)
    }
  })

  it('does not conclude early with nobody around the disappearance — the TTL decides that', () => {
    const t = makeTracker()
    deliver(t)
    const nobody = { lastActivityAt: START - 120_000 }
    for (const dt of [10_000, 15_000, 20_000]) {
      const out = frame(t, LAST_SEEN + dt, { looked: true, ...nobody })
      expect(out.departed).toHaveLength(0)
      expect(out.departedWithoutActivity).toHaveLength(0)
    }
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('a re-sighting between the reads starts the count again (D49)', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 10_000, { looked: true })
    frame(t, LAST_SEEN + 15_000, { looked: true })
    // The detector sees the parcel again: the two empty looks were wrong.
    frame(t, LAST_SEEN + 20_000, { looked: true, sightings: [parcel] })
    const out = frame(t, LAST_SEEN + 25_000, { looked: true })
    expect(out.departed).toHaveLength(0)
  })
})

describe('early pick-up: what may never fire it (fix round 1)', () => {
  it('a raw package box at the place is a presence, whatever the tracker did with it', () => {
    const t = makeTracker()
    deliver(t)
    for (const dt of [10_000, 15_000, 20_000, 25_000]) {
      const out = frame(t, LAST_SEEN + dt, {
        looked: true,
        rawPackageBoxes: [{ x: 106, y: 165, w: 268, h: 77 }],
      })
      expect(out.departed).toHaveLength(0)
    }
  })

  it('an activity window of 0 never concludes early — nobody is known to be there (M2)', () => {
    const t = makeTracker()
    deliver(t)
    let unbacked: readonly string[] = []
    for (const dt of [10_000, 15_000, 20_000, 25_000]) {
      const out = frame(t, LAST_SEEN + dt, { looked: true, activityWindowMs: 0 })
      expect(out.departed).toHaveLength(0)
      unbacked = [...unbacked, ...out.earlyEvidenceUnbacked.map((u) => u.reason)]
    }
    // Said ONCE per candidate, with the reason.
    expect(unbacked).toEqual(['no-activity-window'])
  })

  it('complete evidence with nobody around is said once, and left to the TTL (L1)', () => {
    const t = makeTracker()
    deliver(t)
    const nobody = { lastActivityAt: START - 120_000 }
    const reasons: string[] = []
    for (const dt of [10_000, 15_000, 20_000, 25_000]) {
      const out = frame(t, LAST_SEEN + dt, { looked: true, ...nobody })
      reasons.push(...out.earlyEvidenceUnbacked.map((u) => u.reason))
    }
    expect(reasons).toEqual(['nobody-around'])
  })
})

describe('the early pick-up setting (D687)', () => {
  it('defaults OFF — one pick-up on one camera is no sample to enable it on', () => {
    expect(PACKAGE_DROP_DEFAULTS.packageDropEarlyPickupEnabled).toBe(false)
    expect(resolvePackageDropSettings({}).packageDropEarlyPickupEnabled).toBe(false)
  })

  it('is a per-camera opt-in the resolver honours', () => {
    expect(
      resolvePackageDropSettings({ packageDropEarlyPickupEnabled: true })
        .packageDropEarlyPickupEnabled,
    ).toBe(true)
  })
})
