/**
 * The departure is concluded when its TTL runs out, not when the next frame
 * happens to arrive — but only on EVIDENCE (F4, 2026-09-30).
 *
 * Camera 101, 15:23:07 → 15:28:36: the parcel was last seen at 15:23:07, the
 * TTL expired at 15:28:07 and the pick-up waited 29 s more for the next analysed
 * frame, because expiry was evaluated only inside `observe`. A timer that ages
 * candidates with no frames at all would be WRONG, though: the first frame
 * after a silence runs the governor's poll and re-sights a parcel that is
 * still there — a timer would conclude every parcel left five quiet minutes on
 * the doormat. So `sweep` concludes only a promoted parcel the package step
 * LOOKED for after its last sighting and did not find, unoccluded.
 */

import { describe, expect, it } from 'vitest'
import {
  PACKAGE_STILLNESS_TTL_MS,
  type PackageSighting,
  type PackageStillnessInput,
  PackageStillnessTracker,
} from '../package-stillness-tracker.js'

const DEVICE = 101
const FRAME_W = 640
const FRAME_H = 360
const DOORMAT = { x: 104.5, y: 164.4, w: 271, h: 78 }
const WINDOW = 300_000
const START = 10_000_000

function makeTracker(): PackageStillnessTracker {
  let n = 0
  return new PackageStillnessTracker({ newId: () => `cand-${(n += 1)}` })
}

const parcel: PackageSighting = { className: 'package', bbox: DOORMAT }

function frame(
  t: PackageStillnessTracker,
  timestamp: number,
  over: Partial<PackageStillnessInput> = {},
): ReturnType<PackageStillnessTracker['observe']> {
  return t.observe({
    deviceId: DEVICE,
    sightings: [],
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    timestamp,
    minDwellMs: 0,
    activityWindowMs: WINDOW,
    lastActivityAt: START,
    // What the package step itself returned this frame, BEFORE the tracker:
    // nothing, unless a test says otherwise.
    rawPackageBoxes: [],
    ...over,
  })
}

/** Delivered at START (courier active), last seen at START + 800. */
function deliver(t: PackageStillnessTracker): string {
  frame(t, START, { sightings: [parcel], looked: true })
  frame(t, START + 400, { sightings: [parcel], looked: true })
  const out = frame(t, START + 800, { sightings: [parcel], looked: true })
  const id = out.promoted[0]?.id
  if (id === undefined) throw new Error('fixture: the parcel did not promote')
  return id
}

const LAST_SEEN = START + 800
const EXPIRED = LAST_SEEN + PACKAGE_STILLNESS_TTL_MS + 1

describe('sweep: the TTL is honoured without waiting for a frame', () => {
  it('concludes a pick-up the step LOOKED for and did not find, once the TTL ran out', () => {
    const t = makeTracker()
    const id = deliver(t)
    // The collector's session: somebody in the zone, the step looks twice, no
    // parcel either time.
    frame(t, LAST_SEEN + 15_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    frame(t, LAST_SEEN + 20_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    // …then silence. No frame arrives; the sweep runs on its own clock.
    const early = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED - 2,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(early.departed).toHaveLength(0)
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed.map((e) => e.id)).toEqual([id])
    expect(t.debugCandidateCount(DEVICE)).toBe(0)
  })

  it('never concludes a parcel nobody looked for since — silence is not evidence', () => {
    // The quiet doormat: delivered, then nothing at all for an hour. The next
    // frame's poll would re-sight it; the sweep must not pre-empt that look.
    const t = makeTracker()
    deliver(t)
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: LAST_SEEN + 60 * 60_000,
      activityWindowMs: WINDOW,
      lastActivityAt: START,
    })
    expect(out.departed).toHaveLength(0)
    expect(out.departedWithoutActivity).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('a frame where the step did NOT run is not an absence read', () => {
    const t = makeTracker()
    deliver(t)
    // Frames flow (object detection, person in the zone) but the package step
    // was gated off by the governor: nobody looked at the doormat.
    frame(t, LAST_SEEN + 15_000, { looked: false, lastActivityAt: LAST_SEEN + 13_000 })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
  })

  it('a look whose view of the parcel was blocked by a person is not an absence read', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 15_000, {
      looked: true,
      occluders: [{ x: 150, y: 120, w: 120, h: 200 }],
      lastActivityAt: LAST_SEEN + 13_000,
    })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
  })

  it('a re-sighting wipes the absence reads it contradicts', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 15_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    // The parcel is seen again: the earlier empty look was wrong.
    const seenAgain = LAST_SEEN + 20_000
    frame(t, seenAgain, { sightings: [parcel], looked: true })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: seenAgain + PACKAGE_STILLNESS_TTL_MS + 1,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
    expect(out.departedWithoutActivity).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('keeps the pick-up gate: an attested absence with nobody around is not a pick-up', () => {
    const t = makeTracker()
    const id = deliver(t)
    frame(t, LAST_SEEN + 15_000, { looked: true, lastActivityAt: START - 120_000 })
    frame(t, LAST_SEEN + 20_000, { looked: true, lastActivityAt: START - 120_000 })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: START - 120_000,
    })
    expect(out.departed).toHaveLength(0)
    expect(out.departedWithoutActivity.map((e) => e.id)).toEqual([id])
  })

  it('names the devices it has to sweep, and only those', () => {
    const t = makeTracker()
    expect(t.devicesWithCandidates()).toEqual([])
    deliver(t)
    expect(t.devicesWithCandidates()).toEqual([DEVICE])
  })

  it('ONE absence read is not enough — a second must agree (D49)', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 15_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })

  it('the MOST RECENT look must be an absence: an occluded last look leaves it to the frame', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 15_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    frame(t, LAST_SEEN + 20_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    frame(t, LAST_SEEN + 25_000, {
      looked: true,
      occluders: [{ x: 150, y: 120, w: 120, h: 200 }],
      lastActivityAt: LAST_SEEN + 13_000,
    })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
  })

  it('a RAW package box the tracker dropped is a presence, not an absence', () => {
    // 101, 15:22:57–15:23:08: the step kept detecting the parcel while the
    // tracker lost and retracted its track. Judged on tracker output, each
    // of those frames would have read "empty doormat".
    const t = makeTracker()
    deliver(t)
    for (const dt of [15_000, 20_000]) {
      frame(t, LAST_SEEN + dt, {
        looked: true,
        rawPackageBoxes: [{ x: 106, y: 165, w: 268, h: 77 }],
        lastActivityAt: LAST_SEEN + 13_000,
      })
    }
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
  })

  it('a raw presence after two absences contradicts them', () => {
    const t = makeTracker()
    deliver(t)
    frame(t, LAST_SEEN + 15_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    frame(t, LAST_SEEN + 20_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    frame(t, LAST_SEEN + 25_000, {
      looked: true,
      rawPackageBoxes: [{ x: 106, y: 165, w: 268, h: 77 }],
    })
    frame(t, LAST_SEEN + 30_000, { looked: true, lastActivityAt: LAST_SEEN + 13_000 })
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
  })

  it('a look with no raw detections supplied attests nothing', () => {
    const t = makeTracker()
    deliver(t)
    for (const dt of [15_000, 20_000]) {
      t.observe({
        deviceId: DEVICE,
        sightings: [],
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        timestamp: LAST_SEEN + dt,
        minDwellMs: 0,
        activityWindowMs: WINDOW,
        lastActivityAt: LAST_SEEN + 13_000,
        looked: true,
      })
    }
    const out = t.sweep({
      deviceId: DEVICE,
      timestamp: EXPIRED,
      activityWindowMs: WINDOW,
      lastActivityAt: LAST_SEEN + 13_000,
    })
    expect(out.departed).toHaveLength(0)
  })
})
