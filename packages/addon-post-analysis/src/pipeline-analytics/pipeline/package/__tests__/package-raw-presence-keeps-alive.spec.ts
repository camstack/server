/**
 * The frame-path TTL never concludes a departure on a frame whose own raw
 * package boxes show the parcel (re-review R2, D49).
 *
 * A parcel the detector keeps returning but the tracker keeps dropping (a lost
 * track, a retracted birth — 101's flapping at 15:22:57–15:23:08) used to age
 * on its last TRACKED sighting, and was concluded "picked up" 300 s later on
 * the very frame that showed it. A raw box at the place is a presence: it
 * refreshes the parcel's clock.
 */
import { describe, expect, it } from 'vitest'
import {
  PACKAGE_STILLNESS_TTL_MS,
  type PackageStillnessInput,
  PackageStillnessTracker,
} from '../package-stillness-tracker.js'

const DEVICE = 101
const DOORMAT = { x: 104.5, y: 164.4, w: 271, h: 78 }
const RAW = { x: 106, y: 165, w: 268, h: 77 }
const START = 10_000_000
const LAST_SEEN = START + 800

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
    lastActivityAt: LAST_SEEN + 1_000,
    rawPackageBoxes: [],
    ...over,
  })
}

function deliver(t: PackageStillnessTracker): string {
  const parcel = [{ className: 'package', bbox: DOORMAT }]
  frame(t, START, { sightings: parcel, looked: true, lastActivityAt: START })
  frame(t, START + 400, { sightings: parcel, looked: true, lastActivityAt: START })
  const out = frame(t, LAST_SEEN, { sightings: parcel, looked: true, lastActivityAt: START })
  const id = out.promoted[0]?.id
  if (id === undefined) throw new Error('fixture: the parcel did not promote')
  return id
}

describe('a raw presence keeps the parcel alive', () => {
  it('never concludes on the frame whose raw boxes show the parcel', () => {
    const t = makeTracker()
    deliver(t)
    const out = frame(t, LAST_SEEN + PACKAGE_STILLNESS_TTL_MS + 1, { rawPackageBoxes: [RAW] })
    expect(out.departed).toHaveLength(0)
    expect(out.departedWithoutActivity).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('a parcel only the raw boxes keep seeing survives ten minutes of dropped tracks', () => {
    const t = makeTracker()
    deliver(t)
    for (let i = 1; i <= 10; i += 1) {
      const out = frame(t, LAST_SEEN + i * 60_000, { looked: true, rawPackageBoxes: [RAW] })
      expect(out.departed).toHaveLength(0)
    }
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('the TTL still runs from the LAST raw presence', () => {
    const t = makeTracker()
    const id = deliver(t)
    const lastRaw = LAST_SEEN + 120_000
    frame(t, lastRaw, { looked: true, rawPackageBoxes: [RAW] })
    expect(frame(t, lastRaw + PACKAGE_STILLNESS_TTL_MS).departed).toHaveLength(0)
    const gone = frame(t, lastRaw + PACKAGE_STILLNESS_TTL_MS + 1, { lastActivityAt: lastRaw })
    expect(gone.departed.map((e) => e.id)).toEqual([id])
    // The pick-up moment is the parcel's LAST presence, not its last tracked one.
    expect(gone.departed[0]?.lastConfirmedAt).toBe(lastRaw)
  })
})
