import { describe, it, expect } from 'vitest'
import {
  iou,
  centroid,
  normaliseStationaryClass,
  partitionDetectionsAgainstRegistry,
  trackIsStill,
  DEFAULT_SESSION_STILLNESS_CONFIG,
  findParkedOccupant,
  isOversizeBox,
  bboxMatchesParkedEntry,
  thumbnailWouldShowParkedNotSubject,
} from '../stationary-match.js'
import {
  DEFAULT_DEPARTURE_CONFIG,
  DEFAULT_MATCH_CONFIG,
  type DepartureStrike,
  type StationaryEntry,
} from '../stationary-types.js'

/** An arbitrary observed-frame instant. Departure decisions are decisions about
 *  time separation, so every call has to state one. */
const NOW = 1_000_000

/** A strike armed `ageMs` before {@link NOW}. */
function strikeMap(
  entryId: string,
  ageMs: number,
  absentReads = 0,
): ReadonlyMap<string, DepartureStrike> {
  return new Map([[entryId, { armedAt: NOW - ageMs, absentReads }]])
}

/** Far enough apart that the confirming read cannot be the same optical event. */
const INDEPENDENT_MS = DEFAULT_DEPARTURE_CONFIG.confirmMinGapMs

function entry(over: Partial<StationaryEntry>): StationaryEntry {
  return {
    id: 'e1',
    deviceId: 1,
    className: 'vehicle',
    bbox: { x: 100, y: 100, w: 80, h: 60 },
    frameWidth: 1920,
    frameHeight: 1080,
    firstSeenAt: 0,
    becameStationaryAt: 0,
    lastConfirmedAt: 0,
    ...over,
  }
}

const DIAG = Math.hypot(1920, 1080) // ≈ 2203

describe('geometry', () => {
  it('iou is 1 for identical boxes and 0 for disjoint', () => {
    const b = { x: 0, y: 0, w: 10, h: 10 }
    expect(iou(b, b)).toBe(1)
    expect(iou(b, { x: 100, y: 100, w: 10, h: 10 })).toBe(0)
  })
  it('centroid is the box center', () => {
    expect(centroid({ x: 10, y: 20, w: 40, h: 60 })).toEqual({ x: 30, y: 50 })
  })
})

describe('partitionDetectionsAgainstRegistry — suppress', () => {
  it('suppresses a detection that overlaps a parked entry with same class', () => {
    const entries = [entry({})]
    const detections = [{ bbox: { x: 102, y: 101, w: 80, h: 60 }, className: 'vehicle' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['e1'])
    expect(res.woken).toEqual([])
  })

  it('does NOT suppress a different-class detection over the same box', () => {
    const entries = [entry({ className: 'vehicle' })]
    const detections = [{ bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'person' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.confirmed).toEqual([])
  })

  it('a single detection suppresses at most once across two overlapping entries', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })]
    const detections = [{ bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices]).toEqual([0])
    expect(res.confirmed.length).toBe(2)
  })
})

describe('partitionDetectionsAgainstRegistry — wake', () => {
  it('wakes an entry whose OWN box slid off the parked spot on two INDEPENDENT reads', () => {
    // Entry (100,100,80,60) centroid (140,130). Detection slid to (150,100):
    // it still OVERLAPS the parked box (IoU ~0.23, below suppress) but its
    // centroid (190,130) is now OUTSIDE the parked box → the parked object is
    // departing. The FIRST such read only arms the entry (D49); a second read
    // far enough away to be a different optical event (D279) retires it and
    // releases the detection to spawn a normal moving track.
    const entries = [entry({})]
    const detections = [{ bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'vehicle' }]
    const first = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(first.woken).toEqual([])
    expect(first.strikeChanges).toEqual([
      { entryId: 'e1', strike: { armedAt: NOW, absentReads: 0 }, reason: 'armed' },
    ])

    const second = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(second.suppressedIndices.size).toBe(0)
    expect(second.woken.map((w) => w.entryId)).toEqual(['e1'])
    expect(second.woken[0]!.cause).toBe('contradicting-read')
    expect(second.woken[0]!.strikeAgeMs).toBe(INDEPENDENT_MS)
    expect(second.confirmed).toEqual([])
  })

  it('a tiny jitter (5px shift, IoU high) is suppressed, not woken', () => {
    const entries = [entry({})]
    const detections = [{ bbox: { x: 105, y: 100, w: 80, h: 60 }, className: 'vehicle' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.woken).toEqual([])
  })

  it('suppresses a parked car whose detector box shrank/grew below IoU 0.6 (centroid still inside)', () => {
    // Detector found only part of the car: a smaller box (110,110,50,40) whose
    // centroid (135,130) is still INSIDE the parked entry box — IoU ~0.42 is
    // below the 0.6 suppress floor, but this is box JITTER of the SAME parked
    // object, not a new car. It must be SUPPRESSED (no duplicate track spawn),
    // else the parked car floods a fresh track every jittery frame.
    const entries = [entry({})] // box (100,100,80,60)
    const detections = [{ bbox: { x: 110, y: 110, w: 50, h: 40 }, className: 'vehicle' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(iou(entries[0]!.bbox, detections[0]!.bbox)).toBeLessThan(0.6)
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['e1'])
    expect(res.woken).toEqual([])
  })

  it('does NOT wake on a DIFFERENT vehicle elsewhere in the frame (the 102 parking flood)', () => {
    // Regression: a parked entry near (140,130) must NOT be woken by another
    // vehicle that is simply present elsewhere in the lot with NO box overlap.
    // The old centroid-radius test (0.5 * frame-diagonal ≈ half the frame)
    // let every passing/neighbouring car retire the parked entry → it re-spawned
    // a track and re-flooded. Overlap-gating kills that.
    const entries = [entry({})] // box (100,100,80,60)
    const detections = [
      // A second vehicle 300px away — no overlap with the parked box.
      { bbox: { x: 400, y: 300, w: 80, h: 60 }, className: 'vehicle' },
    ]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(iou(entries[0]!.bbox, detections[0]!.bbox)).toBe(0)
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.woken).toEqual([]) // NOT woken
    expect(res.confirmed).toEqual([])
  })

  it('does NOT wake a parked entry when a neighbour car parks nearby without overlap', () => {
    // Two cars parked ~120px apart (the real 102 geometry): the neighbour must
    // not wake this entry — it spawns/keeps its OWN track/entry instead.
    const entries = [entry({})] // centroid (140,130)
    const detections = [{ bbox: { x: 240, y: 130, w: 80, h: 60 }, className: 'vehicle' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.woken).toEqual([])
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.confirmed).toEqual([])
  })

  it('misses (no confirm, no wake) when no same-class detection overlaps the entry', () => {
    const entries = [entry({})]
    const detections = [{ bbox: { x: 1800, y: 1000, w: 40, h: 40 }, className: 'vehicle' }]
    const res = partitionDetectionsAgainstRegistry({
      entries,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.woken).toEqual([])
    expect(res.confirmed).toEqual([])
  })
})

describe('partitionDetectionsAgainstRegistry — a departure needs an INDEPENDENT read (D49, D279)', () => {
  // The parked box is (100,100,80,60); this detection slid to (150,100), so it
  // overlaps (IoU ≈ 0.23) with its centroid OUTSIDE the parked box — one frame's
  // evidence of a departure, and the exact geometry the old code retired on.
  const departing = [{ bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'vehicle' }]
  const nowhereNear = [{ bbox: { x: 1800, y: 1000, w: 80, h: 60 }, className: 'vehicle' }]

  it('the FIRST departing read arms the entry — it does NOT retire it, and the detection stays suppressed', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    // Nothing is destroyed on one fallible read...
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([
      { entryId: 'e1', strike: { armedAt: NOW, absentReads: 0 }, reason: 'armed' },
    ])
    // ...and we do not act on it either: no track may spawn from a box we do
    // not yet believe departed.
    expect(res.suppressedIndices.has(0)).toBe(true)
  })

  it('TWO departing reads 0.9 s apart do NOT retire — that is one optical event read twice', () => {
    // THE defect. On device 102 a retirement fired on a session's first two
    // frames, 0.9 s apart, off a cold h265 decode; another off a passing car
    // occluding the parked one. Counting to two was satisfied and meant
    // nothing. The entry survives, and the strike is HELD — not advanced, not
    // discarded — with its absence run reset because the object was seen.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', 900),
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([
      { entryId: 'e1', strike: { armedAt: NOW - 900, absentReads: 0 }, reason: 'held' },
    ])
    // And the box we still do not believe may not spawn a track either.
    expect(res.suppressedIndices.has(0)).toBe(true)
  })

  it('a departing read past the separation gap DOES retire — a real departure is not blinded', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(res.woken).toEqual([
      { entryId: 'e1', cause: 'contradicting-read', strikeAgeMs: INDEPENDENT_MS, absentReads: 0 },
    ])
    expect(res.suppressedIndices.size).toBe(0)
  })

  it('a bare MISS never retires an armed entry on its own', () => {
    // `stationary-match.ts` used to treat "I saw nothing" as the second read.
    // On a camera whose captures fail ~25% of the time that is a false-departure
    // generator. One absence, well past the separation gap, still retires
    // nothing — the absence has to be SUSTAINED.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: nowhereNear,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([
      {
        entryId: 'e1',
        strike: { armedAt: NOW - INDEPENDENT_MS, absentReads: 1 },
        reason: 'absent',
      },
    ])
  })

  it('a SUSTAINED absence past the gap retires — a car that drove out of frame is not immortal', () => {
    // The other half of the departure story: a departing car stops overlapping
    // its old box entirely within a frame or two, so a contradicting read may
    // never come. `absenceMinReads` consecutive empty frames past the gap is
    // the independent confirmation for that case.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: nowhereNear,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS, DEFAULT_DEPARTURE_CONFIG.absenceMinReads - 1),
    })
    expect(res.woken).toEqual([
      {
        entryId: 'e1',
        cause: 'sustained-absence',
        strikeAgeMs: INDEPENDENT_MS,
        absentReads: DEFAULT_DEPARTURE_CONFIG.absenceMinReads,
      },
    ])
  })

  it('an absence run one read SHORT of the floor retires nothing', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: nowhereNear,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS, DEFAULT_DEPARTURE_CONFIG.absenceMinReads - 2),
    })
    expect(res.woken).toEqual([])
  })

  it('a long absence INSIDE the separation gap retires nothing either', () => {
    // Both conditions are required: a burst of dropped frames right after the
    // arming read is exactly what a detector dropout looks like.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: nowhereNear,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', 900, 40),
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges[0]!.reason).toBe('absent')
  })

  it('a STRONG re-confirmation CANCELS a pending departure — the object is demonstrably there', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [{ bbox: { x: 102, y: 101, w: 80, h: 60 }, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', 1_500),
    })
    expect(res.woken).toEqual([])
    expect(res.confirmed[0]!.strong).toBe(true)
    expect(res.strikeChanges).toEqual([{ entryId: 'e1', strike: null, reason: 'cancelled-strong' }])
  })

  it('a WEAK (jitter) re-confirmation cancels too — it is still the object, seen badly', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [{ bbox: { x: 110, y: 110, w: 50, h: 40 }, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', 1_500),
    })
    expect(res.confirmed[0]!.strong).toBe(false)
    expect(res.strikeChanges).toEqual([{ entryId: 'e1', strike: null, reason: 'cancelled-weak' }])
  })

  it('a strike nobody confirmed EXPIRES, and the same frame may arm a fresh one', () => {
    // The 17-minute case: a departing read at 17:03 waited forever and was
    // settled by an unrelated session at 17:20. An expired strike is dropped
    // BEFORE this frame is read, so a departing read here starts over rather
    // than cashing in a stale one.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', DEFAULT_DEPARTURE_CONFIG.strikeTtlMs + 1),
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([
      { entryId: 'e1', strike: null, reason: 'expired' },
      { entryId: 'e1', strike: { armedAt: NOW, absentReads: 0 }, reason: 'armed' },
    ])
  })

  it('an expired strike cannot be cashed in by an absence either', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: nowhereNear,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', DEFAULT_DEPARTURE_CONFIG.strikeTtlMs + 1, 99),
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([{ entryId: 'e1', strike: null, reason: 'expired' }])
  })

  it('during the session WARM-UP a departing read is refused and COUNTED, never acted on', () => {
    // The cold-decode frames that produced one of the three observed
    // retirements. Nothing is armed, nothing is retired, the box is still
    // suppressed — and the refusal is a number the sweep line can report,
    // because a branch that drops work is never silent.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      warmUp: true,
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([])
    expect(res.warmUpDepartureReads).toBe(1)
    expect(res.suppressedIndices.has(0)).toBe(true)
  })

  it('the warm-up distrusts DEPARTURES only — a confirmation still lands', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [{ bbox: { x: 102, y: 101, w: 80, h: 60 }, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      warmUp: true,
    })
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['e1'])
    expect(res.warmUpDepartureReads).toBe(0)
  })

  it('a person walking IN FRONT of the parked car neither arms it nor gets absorbed (class gate)', () => {
    // The false-absorption guard: a `person` box straddling the parked
    // `vehicle` must not touch the entry, and must NOT be suppressed — the
    // person is a real subject and gets their own track.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'vehicle' })],
      detections: [{ bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'person' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([])
    expect(res.confirmed).toEqual([])
    expect(res.suppressedIndices.size).toBe(0)
  })

  it('an ARMED entry with no same-class detection is only an ABSENCE — a person in frame says nothing about the car', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'vehicle' })],
      detections: [{ bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'person' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(res.woken).toEqual([])
    expect(res.strikeChanges[0]!.reason).toBe('absent')
    expect(res.suppressedIndices.size).toBe(0)
  })
})

describe('partitionDetectionsAgainstRegistry — a confirmation reports the OBSERVED box', () => {
  it('an unambiguous match (IoU ≥ suppressIou) is reported as re-anchorable', () => {
    const observed = { x: 106, y: 103, w: 80, h: 60 }
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [{ bbox: observed, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    const c = res.confirmed[0]!
    expect(iou(entry({}).bbox, observed)).toBeGreaterThanOrEqual(DEFAULT_MATCH_CONFIG.suppressIou)
    expect(c.strong).toBe(true)
    expect(c.observedBbox).toEqual(observed)
    // The entry's OWN box still rides along — occupancy draws that one.
    expect(c.bbox).toEqual(entry({}).bbox)
  })

  it('a weak (jitter) match is confirmed but NOT re-anchorable', () => {
    // Detector found only part of the car — real, but not a box worth adopting
    // as the new reference: adopting a shrunken box would let the reference
    // walk away from the object it is supposed to pin.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [{ bbox: { x: 110, y: 110, w: 50, h: 40 }, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.confirmed[0]!.strong).toBe(false)
  })
})

describe('trackIsStill — the SESSION-hold predicate, which creates nothing', () => {
  const cfg = DEFAULT_SESSION_STILLNESS_CONFIG

  it('a track younger than the window is not yet still', () => {
    const positions = [
      { x: 100, y: 100, timestamp: 1000 },
      { x: 100, y: 100, timestamp: 2000 },
      { x: 100, y: 100, timestamp: 3000 },
      { x: 100, y: 100, timestamp: 4000 },
    ]
    const res = trackIsStill({
      positions,
      referenceDiagonalPx: DIAG,
      now: 5000, // only 4s old < 30s window
      config: cfg,
    })
    expect(res.still).toBe(false)
  })

  it('a track barely moving across the whole window is still', () => {
    const positions: { x: number; y: number; timestamp: number }[] = []
    for (let t = 0; t <= 40_000; t += 2000) {
      // sub-pixel jitter, far below 0.02*DIAG ≈ 44px net
      positions.push({ x: 500 + (t % 4000 === 0 ? 1 : 0), y: 500, timestamp: t })
    }
    const res = trackIsStill({
      positions,
      referenceDiagonalPx: DIAG,
      now: 40_000,
      config: cfg,
    })
    expect(res.still).toBe(true)
  })

  it('a track that moved across the frame within the window is NOT still', () => {
    const positions: { x: number; y: number; timestamp: number }[] = []
    for (let t = 0; t <= 40_000; t += 2000) {
      positions.push({ x: 100 + t / 50, y: 500, timestamp: t }) // travels ~800px
    }
    const res = trackIsStill({
      positions,
      referenceDiagonalPx: DIAG,
      now: 40_000,
      config: cfg,
    })
    expect(res.still).toBe(false)
  })

  it('a car that drove in then stopped is still (recent window static, whole life not)', () => {
    const positions: { x: number; y: number; timestamp: number }[] = []
    // Drove across the frame for the first 20s...
    for (let t = 0; t < 20_000; t += 2000) positions.push({ x: 100 + t / 25, y: 500, timestamp: t })
    // ...then parked at x≈900 for the last 40s.
    for (let t = 20_000; t <= 60_000; t += 2000) positions.push({ x: 900, y: 500, timestamp: t })
    const res = trackIsStill({
      positions,
      referenceDiagonalPx: DIAG,
      now: 60_000,
      config: cfg,
    })
    expect(res.still).toBe(true)
  })

  it('too few points in the window is not enough to call it still', () => {
    const positions = [
      { x: 500, y: 500, timestamp: 0 },
      { x: 500, y: 500, timestamp: 40_000 },
    ]
    const res = trackIsStill({
      positions,
      referenceDiagonalPx: DIAG,
      now: 40_000,
      config: cfg,
    })
    expect(res.still).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D275 — the measured defect: 13 of 23 tracks on device 102 sat on one of the
// three stationary boxes at IoU ≥ 0.5, i.e. detections that cleared every
// geometric criterion in this file and reached the tracker anyway.
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliseStationaryClass', () => {
  it('maps a raw detector label onto its macro, case-insensitively', () => {
    expect(normaliseStationaryClass('Car')).toBe('vehicle')
    expect(normaliseStationaryClass('car')).toBe('vehicle')
    expect(normaliseStationaryClass('  TRUCK ')).toBe('vehicle')
  })

  it('leaves a macro alone and never collapses two macros together', () => {
    expect(normaliseStationaryClass('vehicle')).toBe('vehicle')
    expect(normaliseStationaryClass('person')).toBe('person')
    expect(normaliseStationaryClass('animal')).toBe('animal')
    expect(normaliseStationaryClass('package')).toBe('package')
    expect(normaliseStationaryClass('vehicle')).not.toBe(normaliseStationaryClass('person'))
  })
})

describe('partitionDetectionsAgainstRegistry — an entry whose stored class is NOT the macro (the `Car` case)', () => {
  it('suppresses a `vehicle` detection sitting on a `Car` entry', () => {
    // The live 102 registry held classes `vehicle`, `Car`, `vehicle`. The
    // detector only ever emits macros (`frame-processor.ts:484`), so under a raw
    // string compare the `Car` entry could never be confirmed, never suppress
    // and never wake — a blind spot that survives until the TTL sweep collects
    // it (up to 30 min of observed time), flooding tracks the whole way.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'Car' })],
      detections: [{ bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['e1'])
  })

  it('a `Car` entry can still be WOKEN by its own departing box', () => {
    // The blindfold cuts both ways: an entry that cannot be matched can never be
    // released either. Two independent departing reads must retire it, exactly
    // like a `vehicle` entry.
    const departing = [{ bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'vehicle' }]
    const first = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'Car' })],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(first.strikeChanges.map((c) => c.reason)).toEqual(['armed'])
    const second = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'Car' })],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(second.woken.map((w) => w.entryId)).toEqual(['e1'])
    expect(second.suppressedIndices.size).toBe(0)
  })

  it('a `Car` entry still does NOT absorb a person standing on it', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'Car' })],
      detections: [{ bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'person' }],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.confirmed).toEqual([])
  })
})

describe('partitionDetectionsAgainstRegistry — suppression reaches EVERY detection on a parked object', () => {
  it('drops a second detection on the same parked box, not only the best match', () => {
    // The defect: the matcher picked ONE best detection per entry and released
    // every other box on the same parked object to the tracker, where it opened
    // a track. Both of these are the parked car.
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})], // (100,100,80,60)
      detections: [
        { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' }, // IoU 1.00
        { bbox: { x: 108, y: 104, w: 76, h: 58 }, className: 'vehicle' },
      ],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices].sort((x, y) => x - y)).toEqual([0, 1])
    expect(res.reachSuppressedCount).toBe(1)
    // One entry, one confirmation — the reach pass confirms nothing and can
    // therefore never re-anchor the reference box.
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['e1'])
    expect(res.confirmed[0]!.observedBbox).toEqual({ x: 100, y: 100, w: 80, h: 60 })
  })

  it('drops a weak second box (IoU ≥ 0.5 but below suppressIou) whose centroid is inside the parked box', () => {
    // This is the exact signature that was measured: IoU ≥ 0.5 against the
    // stationary box — clearing the 0.1 association floor AND the centroid
    // test — which the entry-driven pass released because a better box existed.
    const detections = [
      { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' },
      { bbox: { x: 110, y: 108, w: 60, h: 45 }, className: 'vehicle' },
    ]
    const overlap = iou(entry({}).bbox, detections[1]!.bbox)
    expect(overlap).toBeGreaterThanOrEqual(0.5)
    expect(overlap).toBeLessThan(DEFAULT_MATCH_CONFIG.suppressIou)
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices].sort((x, y) => x - y)).toEqual([0, 1])
    expect(res.reachSuppressedCount).toBe(1)
  })

  it('the reach pass still respects the association floor — a neighbour car is untouched', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [
        { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' },
        { bbox: { x: 240, y: 130, w: 80, h: 60 }, className: 'vehicle' }, // no overlap
      ],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices]).toEqual([0])
    expect(res.reachSuppressedCount).toBe(0)
  })

  it('the reach pass is class-gated — a person over the parked car keeps its track', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({ className: 'vehicle' })],
      detections: [
        { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' },
        { bbox: { x: 110, y: 105, w: 60, h: 50 }, className: 'person' },
      ],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices]).toEqual([0])
    expect(res.reachSuppressedCount).toBe(0)
  })

  it('a WOKEN entry releases every box on its old spot — the departing car is not re-suppressed', () => {
    // The wake is what stops a departed car becoming a permanent blind spot. The
    // reach pass must not undo it: an entry retired this frame suppresses
    // nothing at all, not even a second box still sitting on the old rectangle.
    const departing = [
      { bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'vehicle' }, // IoU ~0.23, centroid outside
      { bbox: { x: 152, y: 103, w: 78, h: 58 }, className: 'vehicle' }, // its twin, also departing
    ]
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(res.woken.map((w) => w.entryId)).toEqual(['e1'])
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.reachSuppressedCount).toBe(0)
  })

  it('a WOKEN entry does not swallow a leftover box still standing on its old spot', () => {
    // The narrow case the woken-entry exclusion exists for, and the only one
    // that can turn a departure into a permanent blind spot.
    //
    // The car's main box has slid off the spot (index 0, the best match →
    // second departing read → the entry is retired). A SECOND box is still
    // sitting inside the old rectangle — the tail of the car mid-manoeuvre, or
    // whatever the departure has uncovered. Its centroid is inside the retired
    // box and it clears the association floor, so without the exclusion the
    // reach pass would suppress it against an entry that no longer exists: the
    // frame that was supposed to hand the object back to the tracker hands it
    // nothing, and the spot goes on absorbing whatever lands on it.
    const leftover = { x: 125, y: 117, w: 30, h: 25 }
    expect(iou(entry({}).bbox, leftover)).toBeGreaterThanOrEqual(DEFAULT_MATCH_CONFIG.wakeAssocIou)
    expect(centroid(leftover).x).toBeGreaterThan(entry({}).bbox.x)
    const res = partitionDetectionsAgainstRegistry({
      entries: [entry({})],
      detections: [
        { bbox: { x: 150, y: 100, w: 80, h: 60 }, className: 'vehicle' }, // departing, best
        { bbox: leftover, className: 'vehicle' },
      ],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
      strikes: strikeMap('e1', INDEPENDENT_MS),
    })
    expect(res.woken.map((w) => w.entryId)).toEqual(['e1'])
    expect(res.suppressedIndices.size).toBe(0)
  })

  it('two parked cars each absorb their own duplicate boxes independently', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [
        entry({ id: 'a', bbox: { x: 100, y: 100, w: 80, h: 60 } }),
        entry({ id: 'b', bbox: { x: 400, y: 400, w: 80, h: 60 } }),
      ],
      detections: [
        { bbox: { x: 100, y: 100, w: 80, h: 60 }, className: 'vehicle' },
        { bbox: { x: 106, y: 103, w: 78, h: 58 }, className: 'vehicle' },
        { bbox: { x: 400, y: 400, w: 80, h: 60 }, className: 'vehicle' },
        { bbox: { x: 405, y: 404, w: 76, h: 57 }, className: 'vehicle' },
      ],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices].sort((x, y) => x - y)).toEqual([0, 1, 2, 3])
    expect(res.reachSuppressedCount).toBe(2)
    expect(res.confirmed.map((c) => c.entryId).sort()).toEqual(['a', 'b'])
  })
})

describe('partitionDetectionsAgainstRegistry — the measured 102 registry (acceptance)', () => {
  // The three boxes the live hub actually holds after the ratio-based promotion
  // shipped, with the classes it actually holds — including the `Car`.
  // On 102's REAL frame. These boxes are 4K coordinates (x reaches 3447) and
  // the helper's default is 1920x1080, under which entry `c` would be 0.45 of
  // the frame — oversize — and held on strong reads only. On 4K it is 0.11.
  const FOUR_K = { frameWidth: 3840, frameHeight: 2160 } as const
  const SIX_ONE_SEVEN: readonly StationaryEntry[] = [
    entry({
      id: 'a',
      className: 'vehicle',
      bbox: { x: 3025.2, y: 337.2, w: 436.8, h: 408 },
      ...FOUR_K,
    }),
    entry({
      id: 'b',
      className: 'Car',
      bbox: { x: 3447.6, y: 630, w: 388.8, h: 760.8 },
      ...FOUR_K,
    }),
    entry({
      id: 'c',
      className: 'vehicle',
      bbox: { x: 1317.6, y: 40.8, w: 1250.4, h: 745.2 },
      ...FOUR_K,
    }),
  ]

  it('no detection landing on a parked box survives to the tracker', () => {
    const detections = [
      // Entry `a`: its own box, plus a second box on the same car.
      { bbox: { x: 3025.2, y: 337.2, w: 436.8, h: 408 }, className: 'vehicle' },
      { bbox: { x: 3040, y: 350, w: 410, h: 390 }, className: 'vehicle' },
      // Entry `b` — the `Car`. A macro detection must still match it.
      { bbox: { x: 3447.6, y: 630, w: 388.8, h: 760.8 }, className: 'vehicle' },
      // Entry `c`: a night box that shrank well below suppressIou.
      { bbox: { x: 1500, y: 200, w: 800, h: 500 }, className: 'vehicle' },
      // A real moving car elsewhere in the frame — MUST keep its track.
      { bbox: { x: 200, y: 1500, w: 300, h: 200 }, className: 'vehicle' },
    ]
    const res = partitionDetectionsAgainstRegistry({
      entries: SIX_ONE_SEVEN,
      detections,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect([...res.suppressedIndices].sort((x, y) => x - y)).toEqual([0, 1, 2, 3])
    expect(res.suppressedIndices.has(4)).toBe(false)
    expect(res.confirmed.map((c) => c.entryId).sort()).toEqual(['a', 'b', 'c'])
    expect(res.woken).toEqual([])
  })

  it('and the parked cars can still all drive away', () => {
    // Each of the three departs: its box slides off its spot, twice.
    const departing = [
      { bbox: { x: 3300, y: 337.2, w: 436.8, h: 408 }, className: 'vehicle' },
      { bbox: { x: 3447.6, y: 1100, w: 388.8, h: 760.8 }, className: 'vehicle' },
      { bbox: { x: 2100, y: 40.8, w: 1250.4, h: 745.2 }, className: 'vehicle' },
    ]
    const first = partitionDetectionsAgainstRegistry({
      entries: SIX_ONE_SEVEN,
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(first.strikeChanges.map((c) => c.entryId).sort()).toEqual(['a', 'b', 'c'])
    expect(first.strikeChanges.every((c) => c.reason === 'armed')).toBe(true)
    expect(first.woken).toEqual([])
    // The confirming frame is a full separation gap later, so none of the three
    // can be retired by the same optical event that armed it.
    const strikes = new Map(
      first.strikeChanges.map((c) => [c.entryId, { armedAt: NOW, absentReads: 0 }] as const),
    )
    const second = partitionDetectionsAgainstRegistry({
      entries: SIX_ONE_SEVEN,
      detections: departing,
      config: DEFAULT_MATCH_CONFIG,
      now: NOW + INDEPENDENT_MS,
      strikes,
    })
    expect(second.woken.map((w) => w.entryId).sort()).toEqual(['a', 'b', 'c'])
    expect(second.suppressedIndices.size).toBe(0)
  })
})

/**
 * An OVERSIZE entry — at or above `OVERSIZE_AREA_FRAC` (0.30) of its frame —
 * holds a detection on a STRONG read only. No jitter hold, no fragment hold.
 *
 * The 102 case (D495, D497, D508): a 1669x1796 box in a 4K frame, 0.361,
 * read every much-smaller contained box as a fragment of itself and swallowed
 * a genuinely different parked motorcycle. The birth bar that answered it
 * could not tell that box from the operator's own car at 0.360; this can,
 * because it does not need to — an oversize entry may exist, and may not
 * REACH. Measured cost on the real car (102, 2026-09-16, 03:26-06:50): 1 717
 * reads absorbed, not one of them weak.
 */
describe('oversize parked entries hold strong reads only (102, 0.36 of 4K)', () => {
  const EXPLODED = entry({
    id: 'exploded',
    bbox: { x: 1000, y: 200, w: 1669, h: 1796 },
    frameWidth: 3840,
    frameHeight: 2160,
  })
  /** A genuine parked motorcycle sitting wholly inside it. */
  const BIKE = { bbox: { x: 1400, y: 900, w: 452.4, h: 420 }, className: 'vehicle' }

  it("is oversize at 0.36, and the operator's car at 0.034 is not", () => {
    expect(isOversizeBox(EXPLODED.bbox, 3840, 2160)).toBe(true)
    expect(isOversizeBox({ x: 3476.4, y: 694.8, w: 360, h: 774 }, 3840, 2160)).toBe(false)
  })

  it('does NOT hold the motorcycle inside it as a fragment — it reaches the tracker', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [EXPLODED],
      detections: [BIKE],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.confirmed).toEqual([])
    expect(findParkedOccupant([EXPLODED], 'vehicle', BIKE.bbox)).toBeUndefined()
  })

  it('a weak overlap on it is a MISS, never a departure it could be woken by', () => {
    // IoU 0.44 with the centroid inside: for a normal entry a jitter hold;
    // for a departing normal entry an arming read. For an oversize entry it
    // is another object in the same scene.
    const passing = { bbox: { x: 1200, y: 400, w: 1200, h: 1100 }, className: 'vehicle' }
    const res = partitionDetectionsAgainstRegistry({
      entries: [EXPLODED],
      detections: [passing],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.strikeChanges).toEqual([])
    expect(res.woken).toEqual([])
  })

  it('still holds its OWN box, which is what the operator asked for', () => {
    const own = { bbox: { x: 1010, y: 210, w: 1660, h: 1780 }, className: 'vehicle' }
    const res = partitionDetectionsAgainstRegistry({
      entries: [EXPLODED],
      detections: [own],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.continuableIndices.size).toBe(0)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['exploded'])
  })
})

describe('scene-sized parked entries (3829 full-frame SUV)', () => {
  // 3164×2059 on 4K ≈ 0.78 of the frame. Centroid-inside would then be true
  // for almost every vehicle in view; only strong IoU may hold the entry.
  const huge = entry({
    id: 'suv',
    bbox: { x: 0, y: 0, w: 3164, h: 2059 },
    frameWidth: 3840,
    frameHeight: 2160,
  })

  it('names a near-full-frame box as scene-sized and a Golf as not', () => {
    expect(isOversizeBox(huge.bbox, huge.frameWidth, huge.frameHeight)).toBe(true)
    expect(isOversizeBox({ x: 100, y: 100, w: 80, h: 60 }, 1920, 1080)).toBe(false)
  })

  it('does not suppress a large overlapping vehicle whose centroid sits inside the huge entry', () => {
    // IoU ≈ 0.29 (above wakeAssoc, below suppress) and centroid inside the SUV
    // box — the old stillParked predicate would swallow this as "still parked".
    const passing = { bbox: { x: 400, y: 200, w: 1600, h: 1200 }, className: 'vehicle' }
    const res = partitionDetectionsAgainstRegistry({
      entries: [huge],
      detections: [passing],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.size).toBe(0)
    expect(res.confirmed).toEqual([])
  })

  it('still suppresses a detection that IS the huge parked box (strong IoU)', () => {
    const same = { bbox: { x: 40, y: 20, w: 3100, h: 2000 }, className: 'vehicle' }
    const res = partitionDetectionsAgainstRegistry({
      entries: [huge],
      detections: [same],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['suv'])
  })
})

describe('merged mover box must not swallow a parked Golf (102)', () => {
  const golf = entry({
    bbox: { x: 200, y: 400, w: 300, h: 200 },
  })
  // Offset merged box: covers the Golf plus the road to the right. Area ≈ 9×
  // the entry, IoU just above the association floor, centroid OUTSIDE the Golf
  // — the old predicate armed a false departure and released the merged box
  // to the tracker on the second independent read.
  const merged = { bbox: { x: 180, y: 350, w: 1400, h: 400 }, className: 'vehicle' }

  it('confirms the parked Golf and suppresses the merged detection', () => {
    const res = partitionDetectionsAgainstRegistry({
      entries: [golf],
      detections: [merged],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.suppressedIndices.has(0)).toBe(true)
    expect(res.confirmed.map((c) => c.entryId)).toEqual(['e1'])
    expect(res.woken).toEqual([])
    expect(res.strikeChanges).toEqual([])
  })

  it('does not turn a same-size slide-off into a swallow (real departure still arms)', () => {
    const slid = { bbox: { x: 420, y: 400, w: 300, h: 200 }, className: 'vehicle' }
    const res = partitionDetectionsAgainstRegistry({
      entries: [golf],
      detections: [slid],
      config: DEFAULT_MATCH_CONFIG,
      now: NOW,
    })
    expect(res.strikeChanges).toEqual([
      { entryId: 'e1', strike: { armedAt: NOW, absentReads: 0 }, reason: 'armed' },
    ])
    expect(res.woken).toEqual([])
    expect(res.suppressedIndices.has(0)).toBe(true)
  })
})

describe('close-time parked match and best-shot veto', () => {
  const golf = entry({ bbox: { x: 200, y: 400, w: 300, h: 200 } })

  it('matches a last-seen box that is the parked Golf', () => {
    expect(bboxMatchesParkedEntry({ x: 205, y: 402, w: 290, h: 195 }, 'vehicle', [golf])).toBe(true)
  })

  it('does not match a mover whose last box is elsewhere', () => {
    expect(bboxMatchesParkedEntry({ x: 900, y: 80, w: 220, h: 140 }, 'vehicle', [golf])).toBe(false)
  })

  it('vetoes a thumbnail that locked onto the parked Golf after the trail started elsewhere', () => {
    expect(
      thumbnailWouldShowParkedNotSubject({
        currentBbox: { x: 205, y: 402, w: 290, h: 195 },
        firstBbox: { x: 900, y: 80, w: 220, h: 140 },
        className: 'vehicle',
        entries: [golf],
      }),
    ).toBe(true)
  })

  it('does not veto when the trail itself started on the parked object', () => {
    expect(
      thumbnailWouldShowParkedNotSubject({
        currentBbox: { x: 205, y: 402, w: 290, h: 195 },
        firstBbox: { x: 200, y: 400, w: 300, h: 200 },
        className: 'vehicle',
        entries: [golf],
      }),
    ).toBe(false)
  })
})
