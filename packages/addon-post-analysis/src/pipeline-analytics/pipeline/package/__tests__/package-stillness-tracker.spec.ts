/**
 * PackageStillnessTracker — the DEDICATED package promotion path.
 *
 * The point of every test here is the cadence: the `package-detection` step is
 * gated by the `MotionSettleGovernor`, whose safety poll is 45s.
 *
 * This path was born (D144) because the generic criterion of the day needed 4
 * recorded positions inside a 30s window and one observation per 45s can never
 * supply them. That arithmetic is GONE — the generic criterion is now
 * repetition in the same place, which a 45s cadence can satisfy. What survives,
 * and what the guard `scripts/check-package-promotion-satisfiable.ts` pins, is
 * the DEDUP: package classes are skipped by the generic loop, so one parcel can
 * never deliver twice under two entry ids.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PACKAGE_STILLNESS_CONFIG,
  PACKAGE_STILLNESS_TTL_MS,
  type PackageSighting,
  PackageStillnessTracker,
} from '../package-stillness-tracker.js'

const DEVICE = 101
/** Device 101's real doormat geometry, measured 2026-08-13 (640×360 frame). */
const FRAME_W = 640
const FRAME_H = 360
const DOORMAT = { x: 104.5, y: 164.4, w: 271, h: 78 }
/** The governor's safety poll — the worst-case cadence this path must survive. */
const POLL_MS = 45_000

function makeTracker(ids: string[] = []): PackageStillnessTracker {
  let n = 0
  return new PackageStillnessTracker({
    newId: () => ids[n] ?? `cand-${(n += 1)}`,
  })
}

function sighting(over: Partial<PackageSighting> = {}): PackageSighting {
  return {
    className: over.className ?? 'package',
    bbox: over.bbox ?? DOORMAT,
    ...(over.trackId !== undefined ? { trackId: over.trackId } : {}),
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.confidence !== undefined ? { confidence: over.confidence } : {}),
    ...(over.keyFrameMediaId !== undefined ? { keyFrameMediaId: over.keyFrameMediaId } : {}),
  }
}

function observe(
  t: PackageStillnessTracker,
  timestamp: number,
  sightings: readonly PackageSighting[],
  minDwellMs = 0,
): ReturnType<PackageStillnessTracker['observe']> {
  return t.observe({
    deviceId: DEVICE,
    sightings,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    timestamp,
    minDwellMs,
  })
}

/** Three frames ~400 ms apart — the default confirmation bar. */
function confirmDefault(t: PackageStillnessTracker, start = 0, minDwellMs = 0) {
  observe(t, start, [sighting()], minDwellMs)
  observe(t, start + 400, [sighting()], minDwellMs)
  return observe(t, start + 800, [sighting()], minDwellMs)
}

describe('the cadence a dedicated path has to survive', () => {
  it('the DEDICATED criterion IS satisfiable at the governor poll cadence', () => {
    const t = makeTracker()
    let promoted = 0
    // Simulate 10 minutes of the governor at its worst case: one observation
    // per poll interval, each a separate short-lived track.
    for (let i = 0; i < 14; i += 1) {
      const at = i * POLL_MS
      const out = observe(t, at, [sighting({ trackId: `track-${i}` })])
      promoted += out.promoted.length
    }
    expect(promoted).toBe(1)
  })
})

describe('re-association survives the track dying between governor rounds', () => {
  it('associates by POSITION, not trackId', () => {
    const t = makeTracker()
    observe(t, 0, [sighting({ trackId: 'a' })])
    observe(t, 63_000, [sighting({ trackId: 'mid' })])
    // Same box, brand-new track id 2 minutes later (device 101's real pattern:
    // 02:01:08 → 02:03:14 → 02:05:29, a different trackId every burst).
    const out = observe(t, 126_000, [
      sighting({
        trackId: 'b',
        bbox: { x: 104.9, y: 164.7, w: 270.9, h: 79.4 },
      }),
    ])
    expect(out.promoted).toHaveLength(1)
    expect(out.promoted[0]?.sourceTrackId).toBe('b')
  })

  it('a DIFFERENT position starts its own candidate instead of re-associating', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    const out = observe(t, POLL_MS, [sighting({ bbox: { x: 500, y: 20, w: 60, h: 40 } })])
    expect(out.promoted).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(2)
  })

  it('two sightings in the SAME frame never both consume one candidate', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    observe(t, POLL_MS, [sighting(), sighting({ bbox: { ...DOORMAT, x: DOORMAT.x + 2 } })])
    // The second (also overlapping) box must have opened its own candidate.
    expect(t.debugCandidateCount(DEVICE)).toBe(2)
  })
})

describe('promotion criterion', () => {
  it('two frames in a settle burst are not enough — default is three hits', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    const out = observe(t, 1_157, [sighting()])
    expect(out.promoted).toHaveLength(0)
  })

  it('three frames in the same settle burst DO promote (the 13:40 miss)', () => {
    // Device 101 2026-08-24: a real parcel on the doormat was seen in one
    // burst then expired because two frames 1.2 s apart counted as ONE round
    // and dwell wanted 15 s. Hits count every frame; dwell defaults to 0.
    const t = makeTracker()
    const out = confirmDefault(t)
    expect(out.promoted).toHaveLength(1)
    expect(out.promoted[0]?.firstSeenAt).toBe(0)
    expect(out.promoted[0]?.becameStationaryAt).toBe(800)
  })

  it('holds promotion until the operator dwell is ALSO met', () => {
    const t = makeTracker()
    confirmDefault(t, 0, 15_000)
    // Three hits at 800 ms, but dwell (15s) is not.
    expect(observe(t, 800, [sighting()], 15_000).promoted).toHaveLength(0)
    const later = observe(t, 20_000, [sighting()], 15_000)
    expect(later.promoted).toHaveLength(1)
    expect(later.promoted[0]?.becameStationaryAt).toBe(20_000)
    expect(later.promoted[0]?.firstSeenAt).toBe(0)
  })

  it('promotes exactly once — a re-confirmed package never re-fires', () => {
    const t = makeTracker()
    expect(confirmDefault(t).promoted).toHaveLength(1)
    for (let i = 2; i < 8; i += 1) {
      expect(observe(t, i * POLL_MS, [sighting()]).promoted).toHaveLength(0)
    }
  })

  it('carries the detector confidence onto the entry (the operator filter)', () => {
    const t = makeTracker()
    observe(t, 0, [sighting({ confidence: 0.5293 })])
    observe(t, 400, [sighting({ confidence: 0.55 })])
    const out = observe(t, 800, [sighting({ confidence: 0.6039 })])
    expect(out.promoted[0]?.confidence).toBe(0.6039)
  })

  it('carries the key-frame media id and label from the latest sighting', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    observe(t, 400, [sighting()])
    const out = observe(t, 800, [sighting({ keyFrameMediaId: 9, label: 'box' })])
    // The candidate's `keyFrameMediaId` field lands on the promoted
    // `StationaryEntry` as `keyFrameMediaId` (D482) — the entry has no
    // "key" of its own to carry.
    expect(out.promoted[0]?.keyFrameMediaId).toBe(9)
    expect(out.promoted[0]?.label).toBe('box')
  })
})

describe('departure', () => {
  it('a promoted package departs after the TTL of OBSERVED time', () => {
    const t = makeTracker()
    const promoted = confirmDefault(t).promoted
    expect(promoted).toHaveLength(1)
    // Frames keep flowing (object-detection runs per-frame) but the package
    // step never sees it again.
    const lastSeen = 800
    const still = observe(t, lastSeen + PACKAGE_STILLNESS_TTL_MS, [])
    expect(still.departed).toHaveLength(0)
    const gone = observe(t, lastSeen + PACKAGE_STILLNESS_TTL_MS + 1, [])
    expect(gone.departed).toHaveLength(1)
    expect(gone.departed[0]?.id).toBe(promoted[0]?.id)
  })

  it('the departed entry keeps the id the delivery used (pairs the pick-up)', () => {
    const t = makeTracker()
    const delivered = confirmDefault(t).promoted[0]
    const gone = observe(t, 10 * PACKAGE_STILLNESS_TTL_MS, [])
    expect(gone.departed[0]?.id).toBe(delivered?.id)
  })

  it('an UNPROMOTED candidate expiring reports no departure', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    const gone = observe(t, PACKAGE_STILLNESS_TTL_MS + 1, [])
    expect(gone.departed).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(0)
  })

  it('no frames means no departure — silence is not evidence the parcel left', () => {
    const t = makeTracker()
    confirmDefault(t)
    // Nothing is called at all for an hour: the entry must survive.
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
  })
})

describe('the activity gate — a parcel needs a deliverer', () => {
  const WINDOW = 300_000

  function observeWithActivity(
    t: PackageStillnessTracker,
    timestamp: number,
    sightings: readonly PackageSighting[],
    lastActivityAt: number | undefined,
  ): ReturnType<PackageStillnessTracker['observe']> {
    return t.observe({
      deviceId: DEVICE,
      sightings,
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      timestamp,
      minDwellMs: 0,
      activityWindowMs: WINDOW,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    })
  }

  function confirmWithActivity(
    t: PackageStillnessTracker,
    start: number,
    lastActivityAt: number | undefined,
  ) {
    observeWithActivity(t, start, [sighting()], lastActivityAt)
    observeWithActivity(t, start + 400, [sighting()], lastActivityAt)
    return observeWithActivity(t, start + 800, [sighting()], lastActivityAt)
  }

  it('a box that appears with NO prior activity never promotes (the light-wedge loop)', () => {
    // Device 101's real night loop: the streetlight wedge "reappears" out of
    // nowhere — no person, no vehicle preceded it. ~23 false notifications a
    // night came from exactly this.
    const t = makeTracker()
    const start = 10_000_000
    observeWithActivity(t, start, [sighting()], undefined)
    let promoted = 0
    for (let i = 1; i < 10; i += 1) {
      promoted += observeWithActivity(t, start + i * POLL_MS, [sighting()], undefined).promoted
        .length
    }
    expect(promoted).toBe(0)
  })

  it('recent activity at candidate open ⇒ promotes normally (the courier case)', () => {
    const t = makeTracker()
    const start = 10_000_000
    // Courier (person track) was active 2 minutes before the first package
    // sighting — the governor's cadence means the box is often first seen
    // minutes after the drop.
    const courierAt = start - 120_000
    const out = confirmWithActivity(t, start, courierAt)
    expect(out.promoted).toHaveLength(1)
  })

  it('activity arriving AFTER an unbacked open does not retroactively validate', () => {
    // Wedge appears at night, candidate opens unbacked; a passer-by shows up
    // later while the wedge is still there. The passer-by must not turn the
    // wedge into a delivery.
    const t = makeTracker()
    const start = 10_000_000
    observeWithActivity(t, start, [sighting()], undefined)
    const walker = start + 60_000
    let promoted = 0
    for (let i = 1; i < 10; i += 1) {
      promoted += observeWithActivity(t, start + i * POLL_MS, [sighting()], walker).promoted.length
    }
    expect(promoted).toBe(0)
  })

  it('stale activity (outside the window) does not back a candidate', () => {
    const t = makeTracker()
    const start = 10_000_000
    const staleAt = start - WINDOW - 1
    const out = confirmWithActivity(t, start, staleAt)
    expect(out.promoted).toHaveLength(0)
  })

  it('window 0 disables the gate entirely (default/back-compat)', () => {
    const t = makeTracker()
    expect(confirmDefault(t).promoted).toHaveLength(1)
  })

  it('a pickup with nobody around lands in departedWithoutActivity, not departed', () => {
    // Delivered normally (courier present), then the box stops being observed
    // with NO activity anywhere near the disappearance — that is not a pickup,
    // that is the detector losing the box (or the light turning off).
    const t = makeTracker()
    const start = 10_000_000
    const courierAt = start - 120_000
    const promoted = confirmWithActivity(t, start, courierAt).promoted
    expect(promoted).toHaveLength(1)
    const lastSeen = start + 800
    const gone = observeWithActivity(t, lastSeen + PACKAGE_STILLNESS_TTL_MS + 1, [], courierAt)
    expect(gone.departed).toHaveLength(0)
    expect(gone.departedWithoutActivity).toHaveLength(1)
    expect(gone.departedWithoutActivity[0]?.id).toBe(promoted[0]?.id)
  })

  it('a pickup with somebody around the disappearance is a real departure', () => {
    const t = makeTracker()
    const start = 10_000_000
    expect(confirmWithActivity(t, start, start).promoted).toHaveLength(1)
    // Somebody walked through right when the box was last seen.
    const lastSeen = start + 800
    const gone = observeWithActivity(
      t,
      lastSeen + PACKAGE_STILLNESS_TTL_MS + 1,
      [],
      lastSeen + 30_000,
    )
    expect(gone.departed).toHaveLength(1)
    expect(gone.departedWithoutActivity).toHaveLength(0)
  })
})

describe('expiry says WHY — the 2026-08-18 13:41 silence', () => {
  it('an unpromoted candidate that ages out is reported with its counters', () => {
    // Two frames 1 s apart is two hits, not enough for the default of three.
    const t = makeTracker()
    observe(t, 0, [sighting()])
    observe(t, 1_000, [sighting()])
    const gone = observe(t, PACKAGE_STILLNESS_TTL_MS + 1_001, [])
    expect(gone.expired).toHaveLength(1)
    const ex = gone.expired[0]
    expect(ex?.hits).toBe(2)
    expect(ex?.firstSeenAt).toBe(0)
    expect(ex?.lastSeenAt).toBe(1_000)
    expect(ex?.activityBackedAtOpen).toBe(true)
  })

  it('a PROMOTED entry aging out is a departure, never an expiry report', () => {
    const t = makeTracker()
    expect(confirmDefault(t).promoted).toHaveLength(1)
    const gone = observe(t, 800 + PACKAGE_STILLNESS_TTL_MS + 1, [])
    expect(gone.departed).toHaveLength(1)
    expect(gone.expired).toHaveLength(0)
  })
})

describe('device isolation and teardown', () => {
  it('candidates never leak across devices', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    const out = t.observe({
      deviceId: 102,
      sightings: [sighting()],
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      timestamp: POLL_MS,
      minDwellMs: 15_000,
    })
    expect(out.promoted).toHaveLength(0)
    expect(t.debugCandidateCount(DEVICE)).toBe(1)
    expect(t.debugCandidateCount(102)).toBe(1)
  })

  it('forgetDevice drops only that device', () => {
    const t = makeTracker()
    observe(t, 0, [sighting()])
    t.forgetDevice(DEVICE)
    expect(t.debugCandidateCount(DEVICE)).toBe(0)
  })
})

describe('the defaults are satisfiable by construction', () => {
  it('the round gap fits inside one governor poll', () => {
    expect(DEFAULT_PACKAGE_STILLNESS_CONFIG.roundGapMs).toBeLessThanOrEqual(POLL_MS)
  })

  it('the candidate TTL outlasts several governor polls', () => {
    expect(DEFAULT_PACKAGE_STILLNESS_CONFIG.ttlMs).toBeGreaterThanOrEqual(4 * POLL_MS)
  })

  it('promotion completes well inside the TTL', () => {
    const worstCaseMs = (DEFAULT_PACKAGE_STILLNESS_CONFIG.minHits - 1) * POLL_MS
    expect(worstCaseMs).toBeLessThan(DEFAULT_PACKAGE_STILLNESS_CONFIG.ttlMs)
  })
})
