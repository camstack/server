/**
 * How a parked object earns a registry entry — the RATIO criterion.
 *
 * Every fixture below is a real profile measured on device 102 (the operator's
 * parking lot) over 24 h on 2026-08-27/28 via `pipelineAnalytics.listTracks`.
 * The bench is the fact the operator reports: three cars are parked in view and
 * the registry holds exactly one entry.
 *
 *   - CAR_A  [3463,637,370x739] — re-discovered as 140 separate tracks in 24 h,
 *            median life 6.8 s. Agreement 6405/6467 = 0.99.
 *   - CAR_B  [3049,316,424x430] — 112 separate tracks. Agreement 343/343 = 1.00.
 *   - CROSSING — a car driving across the lot, 70 observations from
 *            [2572,5,236x198] to [3733,1303,104x498]. Agreement 5/70 = 0.07.
 *
 * Each negative is proved against a CONTROL that must hold, so no assertion can
 * pass because the fixture simply never reached the code.
 */
import { makeAnalyticsRecordsNow } from '../../../__tests__/fake-records.js'
import { describe, expect, it, vi } from 'vitest'

import { makeSilentLogger } from '../../../__tests__/test-helpers.js'
import {
  PERSON_EVIDENCE_POLICY,
  EVIDENCE_REBIND_MAX_BOUND_OVERLAP,
  VEHICLE_EVIDENCE_POLICY,
  evaluateStationaryEvidence,
  evidencePolicyFor,
  type StationaryEvidenceRow,
  type StationaryEvidenceSource,
  type StationaryObservation,
} from '../stationary-evidence.js'
import type { TrackState } from '@camstack/types'
import { StationaryEvidenceLedger } from '../stationary-evidence-ledger.js'
import { iou } from '../stationary-match.js'
import type { StationaryBbox } from '../stationary-types.js'

const T0 = 1_787_800_000_000
const DEV = 102
/** 102's frame. Every observation carries it — the artifact rule lives in the
 *  verdict and a fraction of nothing is not a measurement. */
const FRAME = { frameWidth: 3840, frameHeight: 2160 } as const

const CAR_A: StationaryBbox = { x: 3463, y: 637, w: 370, h: 739 }
const CAR_B: StationaryBbox = { x: 3049, y: 316, w: 424, h: 430 }

function makeLedger(): StationaryEvidenceLedger {
  return new StationaryEvidenceLedger({
    records: makeAnalyticsRecordsNow().records,
    logger: makeSilentLogger(),
  })
}

function jitter(box: StationaryBbox, i: number): StationaryBbox {
  // Real 102 night boxes move a few px between frames; this is that amplitude.
  const d = (i % 5) - 2
  return { x: box.x + d * 3, y: box.y + d * 2, w: box.w, h: box.h }
}

interface Sighting {
  readonly bbox: StationaryBbox
  readonly at: number
  readonly trackId: string
  readonly source?: StationaryEvidenceSource
  /** The tracker's verdict on a SESSION sighting. Defaults to `idle` — the
   *  measured profiles below are of parked cars the tracker called still —
   *  and a burst sighting carries none, exactly as production builds it. */
  readonly state?: TrackState
}

function feed(
  ledger: StationaryEvidenceLedger,
  sightings: readonly Sighting[],
  className = 'vehicle',
): boolean {
  let promoted = false
  for (const s of sightings) {
    const source = s.source ?? 'session'
    const movementState = source === 'burst' ? undefined : (s.state ?? 'idle')
    const observation: StationaryObservation = {
      deviceId: DEV,
      className,
      bbox: s.bbox,
      timestamp: s.at,
      source,
      trackId: s.trackId,
      ...FRAME,
      ...(movementState !== undefined ? { movementState } : {}),
    }
    const outcome = ledger.observe(observation)
    if (outcome?.promoted === true) promoted = true
  }
  return promoted
}

/** The two missed cars' real shape: a handful of sightings per session, many
 *  short sessions, minutes apart. `sessions` x `perSession` observations. */
function nightProfile(
  box: StationaryBbox,
  sessions: number,
  perSession: number,
  gapMs: number,
): Sighting[] {
  const out: Sighting[] = []
  for (let s = 0; s < sessions; s++) {
    const trackId = `t${s}`
    for (let i = 0; i < perSession; i++) {
      out.push({ bbox: jitter(box, i), at: T0 + s * gapMs + i * 100, trackId })
    }
  }
  return out
}

describe('stationary evidence — the criterion is a RATIO, not a count', () => {
  it('promotes the two night cars: FEW sightings, high positional consistency', () => {
    const ledger = makeLedger()
    // 3 sessions x 5 sightings = 15 observations spread over 5 minutes. This is
    // less than a quarter of what one 30 s track produces today, and today's
    // track-continuity criterion cannot promote it at all.
    const promoted = feed(ledger, nightProfile(CAR_A, 3, 5, 150_000))
    expect(promoted).toBe(true)
  })

  it('does NOT promote MANY sightings with poor positional consistency', () => {
    const ledger = makeLedger()
    // 200 observations from ONE long-lived track that binds to a spot and then
    // wanders: N is enormous, the span is 10 minutes, only the ratio refuses.
    const wander: Sighting[] = []
    for (let i = 0; i < 200; i++) {
      const box = i < 20 ? jitter(CAR_A, i) : { ...CAR_A, x: CAR_A.x - i * 12 }
      wander.push({ bbox: box, at: T0 + i * 3_000, trackId: 'wanderer' })
    }
    expect(feed(ledger, wander)).toBe(false)

    // CONTROL: the SAME count and the SAME span, but the object stays put.
    const still: Sighting[] = []
    for (let i = 0; i < 200; i++) {
      still.push({ bbox: jitter(CAR_A, i), at: T0 + i * 3_000, trackId: 'parked' })
    }
    expect(feed(makeLedger(), still)).toBe(true)
  })

  it('a car that merely DRIVES THROUGH the spot dilutes its own evidence', () => {
    const ledger = makeLedger()
    // The measured CROSSING profile: it agrees with the spot for a few frames,
    // then keeps being seen elsewhere for the rest of its life.
    const crossing: Sighting[] = []
    for (let i = 0; i < 5; i++) {
      crossing.push({ bbox: jitter(CAR_A, i), at: T0 + i * 200, trackId: 'crossing' })
    }
    for (let i = 5; i < 70; i++) {
      crossing.push({
        bbox: { x: CAR_A.x - (i - 4) * 45, y: CAR_A.y + (i - 4) * 18, w: 236, h: 198 },
        at: T0 + i * 4_000,
        trackId: 'crossing',
      })
    }
    expect(feed(ledger, crossing)).toBe(false)
  })

  it('refuses evidence that never STRETCHES — a four-second stop is not parking', () => {
    const ledger = makeLedger()
    // 40 sightings, perfect agreement, 4.0 s apart end to end. This is the real
    // 102 profile of the two momentary stops the day produced (4.2 s and 8.0 s).
    const stop: Sighting[] = []
    for (let i = 0; i < 40; i++) {
      stop.push({ bbox: jitter(CAR_B, i), at: T0 + i * 100, trackId: 'brief' })
    }
    expect(feed(ledger, stop)).toBe(false)

    // CONTROL: the same 40 sightings, stretched past the span floor.
    const stretched = stop.map((s, i) => ({ ...s, at: T0 + i * 4_000 }))
    expect(feed(makeLedger(), stretched)).toBe(true)
  })

  it('needs evidence to exist at all — one lonely sighting is not a candidate', () => {
    const ledger = makeLedger()
    const sparse: Sighting[] = [
      { bbox: CAR_B, at: T0, trackId: 'a' },
      { bbox: CAR_B, at: T0 + 300_000, trackId: 'b' },
    ]
    expect(feed(ledger, sparse)).toBe(false)
  })
})

describe('stationary evidence — ONE ledger, two producers', () => {
  it('an object confirmed HALF by a session and HALF by a burst still promotes', () => {
    const ledger = makeLedger()
    const mixed: Sighting[] = []
    for (let i = 0; i < 6; i++) {
      mixed.push({ bbox: jitter(CAR_A, i), at: T0 + i * 100, trackId: 'sess', source: 'session' })
    }
    for (let i = 0; i < 6; i++) {
      mixed.push({
        bbox: jitter(CAR_A, i),
        at: T0 + 200_000 + i * 100,
        trackId: 'burst',
        source: 'burst',
      })
    }
    expect(feed(ledger, mixed)).toBe(true)
  })

  it('keeps the two producers COUNTED apart, so "does the burst earn its keep" has an answer', () => {
    const ledger = makeLedger()
    feed(ledger, [
      { bbox: CAR_A, at: T0, trackId: 'x', source: 'session' },
      { bbox: CAR_A, at: T0 + 1_000, trackId: 'x', source: 'burst' },
      { bbox: CAR_A, at: T0 + 2_000, trackId: 'x', source: 'burst' },
    ])
    const row = ledger.candidatesFor(DEV)[0]
    expect(row?.sessionAgreed).toBe(1)
    expect(row?.burstAgreed).toBe(2)
  })
})

describe('stationary evidence — "same position" is IoU, and only IoU', () => {
  it('two sightings of the same car with different boxes are ONE candidate', () => {
    const ledger = makeLedger()
    // The write and the read use DIFFERENT coordinates on purpose: a candidate
    // found by quantising a point would put these in different buckets (the
    // predecessor mechanism writes a centroid and reads a corner). Overlap does
    // not care where you measure from.
    feed(ledger, [
      { bbox: CAR_A, at: T0, trackId: 'first' },
      {
        bbox: { x: CAR_A.x + 60, y: CAR_A.y + 90, w: 400, h: 700 },
        at: T0 + 5_000,
        trackId: 'second',
      },
    ])
    expect(ledger.candidatesFor(DEV)).toHaveLength(1)
  })

  it('two genuinely different parking spots are TWO candidates', () => {
    const ledger = makeLedger()
    feed(ledger, [
      { bbox: CAR_A, at: T0, trackId: 'a' },
      { bbox: CAR_B, at: T0 + 1_000, trackId: 'b' },
    ])
    expect(ledger.candidatesFor(DEV)).toHaveLength(2)
  })
})

describe('stationary evidence — class policy', () => {
  // Persons promote like every other class since 2026-09-14 — the per-camera
  // switch is gone, because an opt-in nobody turned on produced nothing. What
  // holds the false-positive rate down is no longer an off switch: it is the
  // thresholds below, plus `observationAgrees` requiring the TRACKER to call
  // the subject still, so a person who merely pauses inside the anchor no
  // longer feeds it.
  it('person does NOT promote on evidence a vehicle promotes on — the thresholds still differ', () => {
    // Ten minutes of perfect agreement: past every VEHICLE threshold, short of
    // the half hour a person has to stand there.
    const tenMinutes = nightProfile(CAR_A, 4, 20, 200_000)
    expect(feed(makeLedger(), tenMinutes, 'person')).toBe(false)

    // CONTROL: the identical sequence, as a vehicle, promotes.
    expect(feed(makeLedger(), tenMinutes, 'vehicle')).toBe(true)
  })

  it('a person DOES promote once the evidence clears the person thresholds — no switch is involved', () => {
    // Forty minutes, 240 agreeing observations, ratio 1.00. Before 2026-09-14
    // this returned false no matter how strong it was, because the class was
    // gated off by a setting nobody turned on.
    expect(feed(makeLedger(), nightProfile(CAR_A, 12, 20, 200_000), 'person')).toBe(true)
  })

  it('person is far stricter than vehicle', () => {
    expect(PERSON_EVIDENCE_POLICY.minAgreementRatio).toBeGreaterThan(
      VEHICLE_EVIDENCE_POLICY.minAgreementRatio,
    )
    expect(PERSON_EVIDENCE_POLICY.minSpanMs).toBeGreaterThan(VEHICLE_EVIDENCE_POLICY.minSpanMs)
    expect(PERSON_EVIDENCE_POLICY.minAgreed).toBeGreaterThan(VEHICLE_EVIDENCE_POLICY.minAgreed)
  })

  it('an unlisted class falls back to the vehicle policy', () => {
    expect(evidencePolicyFor('animal')).toBe(VEHICLE_EVIDENCE_POLICY)
    expect(evidencePolicyFor('person')).toBe(PERSON_EVIDENCE_POLICY)
  })
})

describe('stationary evidence — a refusal says WHY', () => {
  const row = (over: Partial<StationaryEvidenceRow>): StationaryEvidenceRow => ({
    key: 'k',
    deviceId: DEV,
    className: 'vehicle',
    anchor: CAR_A,
    agreed: 100,
    seen: 100,
    // The RATIO is asked of the window; the lifetime counters answer
    // `minAgreed` and the span. A healthy candidate agrees with itself in both.
    windowAgreed: 100,
    windowSeen: 100,
    prevWindowAgreed: 0,
    prevWindowSeen: 0,
    windowStartedAt: T0,
    firstAgreedAt: T0,
    lastAgreedAt: T0 + 600_000,
    bestBbox: CAR_A,
    sessionAgreed: 100,
    burstAgreed: 0,
    undecided: 0,
    updatedAt: T0 + 600_000,
    ...over,
  })

  it('names the FIRST thing the candidate failed, not the last', () => {
    const cfg = VEHICLE_EVIDENCE_POLICY
    expect(evaluateStationaryEvidence(row({}), cfg, FRAME).kind).toBe('promote')
    expect(
      evaluateStationaryEvidence(
        row({ agreed: 2, seen: 2, windowAgreed: 2, windowSeen: 2 }),
        cfg,
        FRAME,
      ),
    ).toMatchObject({
      kind: 'accumulating',
      shortfall: 'too-few-agreements',
    })
    expect(
      evaluateStationaryEvidence(
        row({ agreed: 20, seen: 200, windowAgreed: 20, windowSeen: 200 }),
        cfg,
        FRAME,
      ),
    ).toMatchObject({
      shortfall: 'inconsistent-position',
    })
    expect(evaluateStationaryEvidence(row({ lastAgreedAt: T0 + 1_000 }), cfg, FRAME)).toMatchObject(
      {
        shortfall: 'span-too-short',
      },
    )
  })
})

/**
 * The RATIO describes NOW, and the counters describe a lifetime.
 *
 * Measured on 102 on 2026-09-13, a year after these thresholds were tuned:
 * every failing vehicle candidate had abundant agreements (578, 296, 117 against
 * a floor of 8) and an enormous span (up to 34.7 h against 120 s), and failed on
 * the ratio alone — 0.06, 0.20, 0.23, 0.34, 0.53. The gap the threshold sits in,
 * measured at [0.29, 0.90], had closed up: a car parked NEXT TO a busy lane
 * accumulates the dilution of everything that drives past, for ever, and no
 * object however motionless can outrun a denominator that never forgets.
 */
describe('stationary evidence — the ratio is a WINDOW, not a lifetime', () => {
  const cfg = VEHICLE_EVIDENCE_POLICY

  const parkedAllDay = (over: Partial<StationaryEvidenceRow> = {}): StationaryEvidenceRow => ({
    key: 'k',
    deviceId: DEV,
    className: 'vehicle',
    anchor: CAR_A,
    // A day and a half of history: agreements aplenty, and a denominator
    // stuffed with everything that has driven past.
    agreed: 578,
    seen: 2463,
    windowAgreed: 40,
    windowSeen: 41,
    prevWindowAgreed: 30,
    prevWindowSeen: 31,
    windowStartedAt: T0,
    firstAgreedAt: T0 - 124_967_598,
    lastAgreedAt: T0,
    bestBbox: CAR_A,
    sessionAgreed: 578,
    burstAgreed: 0,
    undecided: 0,
    updatedAt: T0,
    ...over,
  })

  it('promotes a car whose LIFETIME ratio is 0.23 but is motionless NOW', () => {
    // The exact shape of the candidate the operator watched flood their list.
    const verdict = evaluateStationaryEvidence(parkedAllDay(), cfg, FRAME)
    expect(verdict.kind).toBe('promote')
    expect(verdict.ratio).toBeGreaterThan(cfg.minAgreementRatio)
    // The lifetime numbers are still REPORTED — they answer the other two
    // gates, and a diagnostic that hid them would hide the history.
    expect(verdict.agreed).toBe(578)
    expect(verdict.seen).toBe(2463)
  })

  it('still refuses a car CROSSING the lot — the dilution that matters is recent', () => {
    // A mover binds for a few frames and then contributes dozens of disagreeing
    // observations IN THE SAME WINDOW. That separation is the whole criterion
    // and it survives untouched.
    const verdict = evaluateStationaryEvidence(
      parkedAllDay({ windowAgreed: 5, windowSeen: 70, prevWindowAgreed: 0, prevWindowSeen: 0 }),
      cfg,
      FRAME,
    )
    expect(verdict).toMatchObject({ kind: 'accumulating', shortfall: 'inconsistent-position' })
  })

  it('an EMPTY window answers 0 — nothing recent is not a stale verdict', () => {
    const verdict = evaluateStationaryEvidence(
      parkedAllDay({ windowAgreed: 0, windowSeen: 0, prevWindowAgreed: 0, prevWindowSeen: 0 }),
      cfg,
      FRAME,
    )
    expect(verdict.ratio).toBe(0)
    expect(verdict.kind).toBe('accumulating')
  })

  it('the SPAN still governs — a four-second stop cannot promote on a perfect window', () => {
    // `minSpanMs` is the real discriminator and it reads the candidate's whole
    // life, untouched by the window.
    const verdict = evaluateStationaryEvidence(
      parkedAllDay({ firstAgreedAt: T0 - 4_200, agreed: 40, seen: 40 }),
      cfg,
      FRAME,
    )
    expect(verdict).toMatchObject({ shortfall: 'span-too-short' })
  })
})

// ── D280: a track bound to the WRONG candidate re-matches ───────────────────
describe('stationary evidence — a track bound to the wrong candidate re-matches', () => {
  /** Total M across a device's candidates. It must always equal the number of
   *  observations the device offered: a re-bind moves a TRACK, never a tally. */
  function totalSeen(ledger: StationaryEvidenceLedger): number {
    return ledger.candidatesFor(DEV).reduce((acc, r) => acc + r.seen, 0)
  }

  it('re-binds when the bound row is nowhere near the box and another candidate agrees', () => {
    const ledger = makeLedger()
    // CAR_B's spot already has a candidate, built by a different track.
    feed(ledger, [{ bbox: CAR_B, at: T0, trackId: 'other' }])
    // `t1` is emitted on a SETTLING box that lands on CAR_A's spot, so it binds
    // there. That is the D280 defect's first frame.
    feed(ledger, [{ bbox: CAR_A, at: T0 + 100, trackId: 't1' }])
    const bound = ledger.bindingsFor(DEV).find((b) => b.trackId === 't1')
    expect(bound).toBeDefined()

    // Now t1 reports where it actually IS — CAR_B's spot, which the bound row
    // essentially does not overlap and the other candidate matches exactly.
    expect(iou(CAR_A, CAR_B)).toBeLessThan(EVIDENCE_REBIND_MAX_BOUND_OVERLAP)
    feed(ledger, [{ bbox: CAR_B, at: T0 + 200, trackId: 't1' }])
    const rebound = ledger.bindingsFor(DEV).find((b) => b.trackId === 't1')
    expect(rebound?.candidateKey).not.toBe(bound?.candidateKey)

    // The candidate t1 now feeds is CAR_B's, and it got the agreement.
    const carB = ledger.candidatesFor(DEV).find((r) => r.key === rebound?.candidateKey)
    expect(carB?.agreed).toBe(2)
  })

  it('the re-bind moves the TRACK, never a tally — no observation is counted twice', () => {
    const ledger = makeLedger()
    feed(ledger, [{ bbox: CAR_B, at: T0, trackId: 'other' }])
    feed(ledger, [{ bbox: CAR_A, at: T0 + 100, trackId: 't1' }])
    feed(ledger, [{ bbox: CAR_B, at: T0 + 200, trackId: 't1' }])
    feed(ledger, [{ bbox: CAR_B, at: T0 + 300, trackId: 't1' }])
    // Four observations were offered; four is what the candidates hold between
    // them. The abandoned row keeps exactly the one it already earned.
    expect(totalSeen(ledger)).toBe(4)
    const rows = ledger.candidatesFor(DEV)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.seen).sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('does NOT re-bind on a merely POOR fit — dilution is the whole point of M', () => {
    // A car that drove through a spot must keep diluting the candidate it bound
    // to. Overlap here is well below `agreeIou` but well above the re-bind
    // floor, which is what separates "a bad frame" from "the wrong row".
    const ledger = makeLedger()
    feed(ledger, [{ bbox: CAR_B, at: T0, trackId: 't1' }])
    const drifted: StationaryBbox = { ...CAR_B, x: CAR_B.x + CAR_B.w * 0.75 }
    const overlap = iou(CAR_B, drifted)
    expect(overlap).toBeGreaterThan(0.05)
    expect(overlap).toBeLessThan(VEHICLE_EVIDENCE_POLICY.agreeIou)
    // A second candidate exists exactly where the drifted box is.
    feed(ledger, [{ bbox: drifted, at: T0 + 50, trackId: 'other' }])
    feed(ledger, [{ bbox: drifted, at: T0 + 100, trackId: 't1' }])

    const t1 = ledger.bindingsFor(DEV).find((b) => b.trackId === 't1')
    const t1Row = ledger.candidatesFor(DEV).find((r) => r.key === t1?.candidateKey)
    expect(t1Row?.anchor).toEqual(CAR_B)
    // Bound row diluted, not abandoned: 2 seen, 1 agreed.
    expect(t1Row?.seen).toBe(2)
    expect(t1Row?.agreed).toBe(1)
  })

  it('does NOT re-bind when NO other candidate reaches agreeIou — a novel spot', () => {
    const ledger = makeLedger()
    feed(ledger, [{ bbox: CAR_A, at: T0, trackId: 't1' }])
    const key = ledger.bindingsFor(DEV).find((b) => b.trackId === 't1')?.candidateKey
    // Somewhere nothing has ever been. The track stays where it is bound and
    // dilutes it, which is exactly what a car crossing the lot should do.
    feed(ledger, [{ bbox: { x: 10, y: 10, w: 50, h: 50 }, at: T0 + 100, trackId: 't1' }])
    expect(ledger.bindingsFor(DEV).find((b) => b.trackId === 't1')?.candidateKey).toBe(key)
    expect(ledger.candidatesFor(DEV)).toHaveLength(1)
    expect(totalSeen(ledger)).toBe(2)
  })

  it('the mis-binding it was written for: the second track PROMOTES the row it is about', () => {
    // The 102 case. Two tracks watch the same parked car; the second is emitted
    // on a settling box that captures a stale candidate elsewhere and, before
    // D280, spent its whole life feeding it. The promotion the pair had already
    // earned arrived minutes late — 3.3 of them, measured.
    const ledger = makeLedger()
    const stale: StationaryBbox = { x: 10, y: 10, w: 100, h: 100 }
    feed(ledger, [{ bbox: stale, at: T0, trackId: 'ghost' }])

    // Track A: ten sightings over ten seconds. Count and ratio are already
    // sufficient; the SPAN is not, and A dies long before it could be.
    const a: Sighting[] = []
    for (let i = 0; i < 10; i++) {
      a.push({ bbox: jitter(CAR_A, i), at: T0 + 1_000 + i * 1_000, trackId: 'tA' })
    }
    expect(feed(ledger, a)).toBe(false)

    // Track B is born two minutes later on a settling box that lands on the
    // stale spot, then watches the same parked car. Its observations reach the
    // car's OWN row, and the span they complete is what promotes it. Bound to
    // the stale row, as they used to be, they promote nothing at all.
    const b: Sighting[] = [{ bbox: stale, at: T0 + 130_000, trackId: 'tB' }]
    for (let i = 0; i < 10; i++) {
      b.push({ bbox: jitter(CAR_A, i), at: T0 + 131_000 + i * 1_000, trackId: 'tB' })
    }
    expect(feed(ledger, b)).toBe(true)
  })
})

/**
 * D508 — the doors this ledger closed, each pinned from both sides.
 */
describe("stationary evidence — a session sighting must carry the tracker's verdict", () => {
  it('the night cars promote when the tracker called them still (control)', () => {
    const ledger = makeLedger()
    expect(feed(ledger, nightProfile(CAR_A, 3, 8, 90_000))).toBe(true)
  })

  it('and never when the sighting carries no verdict — a producer that forgot the field', () => {
    const ledger = makeLedger()
    const blind = nightProfile(CAR_A, 6, 8, 90_000).map((s) => ({ ...s, state: 'new' as const }))
    // `feed` cannot omit the verdict by construction; a forgotten field reads
    // as `undefined` in production, which `observationAgrees` refuses exactly
    // like the warm-up. Pinned directly on the ledger to be sure.
    for (const s of blind) {
      const out = ledger.observe({
        deviceId: DEV,
        className: 'vehicle',
        bbox: s.bbox,
        timestamp: s.at,
        source: 'session',
        trackId: s.trackId,
        ...FRAME,
      })
      expect(out?.promoted).toBe(false)
    }
    expect(ledger.candidatesFor(DEV)[0]?.agreed).toBe(1)
  })

  it('a moving track that overlaps the spot dilutes, and an entering one does not vote', () => {
    const ledger = makeLedger()
    const passing = nightProfile(CAR_A, 6, 8, 90_000).map((s, i) => ({
      ...s,
      state: (i % 2 === 0 ? 'moving' : 'entered') as TrackState,
    }))
    expect(feed(ledger, passing)).toBe(false)
  })
})

describe('stationary evidence — a burst is vouched for by its occasion', () => {
  // Two rechecks, five minutes apart, four frames each: the runner's default.
  // The tracks in them never leave `entered`, and the occasion is the verdict.
  const twoBursts = (): Sighting[] => [
    ...[0, 1, 2, 3].map((i) => ({
      bbox: CAR_A,
      at: T0 + i * 250,
      trackId: 'b1',
      source: 'burst' as const,
    })),
    ...[0, 1, 2, 3].map((i) => ({
      bbox: CAR_A,
      at: T0 + 300_000 + i * 250,
      trackId: 'b2',
      source: 'burst' as const,
    })),
  ]

  it('two rechecks of the same still box promote a vehicle', () => {
    expect(feed(makeLedger(), twoBursts())).toBe(true)
  })

  it('the same eight frames as SESSION sightings of an entering track promote nothing', () => {
    const ledger = makeLedger()
    const asSession = twoBursts().map((s) => ({
      ...s,
      source: 'session' as const,
      state: 'entered' as const,
    }))
    expect(feed(ledger, asSession)).toBe(false)
  })
})

describe('stationary evidence — only an AGREEING observation may mint', () => {
  /**
   * The production shape (102 and 3836, 2026-09-16): a candidate diluted in
   * one ratio bucket and clean in the next; a fold that rotates the diluted
   * bucket out turns the verdict over — and that fold was a one-position
   * `entered` track of some other subject, which the birth path then tore
   * down as "promoted".
   */
  const build = (ledger: StationaryEvidenceLedger): void => {
    // Bucket A: a mover bound to the spot dilutes it — 200 disagreeing.
    feed(ledger, [{ bbox: CAR_A, at: T0, trackId: 'mover' }])
    feed(
      ledger,
      Array.from({ length: 200 }, (_, i) => ({
        bbox: { ...CAR_A, x: CAR_A.x + 2000 },
        at: T0 + 1_000 + i * 50,
        trackId: 'mover',
        state: 'moving' as const,
      })),
    )
    // Bucket B, one window later: the car itself, 100 still sightings.
    feed(
      ledger,
      Array.from({ length: 100 }, (_, i) => ({
        bbox: jitter(CAR_A, i),
        at: T0 + 15 * 60_000 + i * 100,
        trackId: 'car',
      })),
    )
    const row = ledger.candidatesFor(DEV)[0]!
    // Still diluted: A + B in the window.
    expect(evaluateStationaryEvidence(row, VEHICLE_EVIDENCE_POLICY, FRAME).kind).toBe(
      'accumulating',
    )
  }

  it('a disagreeing fold that rotates the window into a clean state does NOT promote', () => {
    const ledger = makeLedger()
    build(ledger)
    const out = ledger.observe({
      deviceId: DEV,
      className: 'vehicle',
      bbox: CAR_A,
      timestamp: T0 + 31 * 60_000,
      source: 'session',
      trackId: 'stranger',
      movementState: 'entered',
      ...FRAME,
    })
    expect(out?.verdict.kind).toBe('promote')
    expect(out?.promoted).toBe(false)
    expect(ledger.candidatesFor(DEV)).toHaveLength(1)
  })

  it('the next observation OF THE OBJECT does', () => {
    const ledger = makeLedger()
    build(ledger)
    ledger.observe({
      deviceId: DEV,
      className: 'vehicle',
      bbox: CAR_A,
      timestamp: T0 + 31 * 60_000,
      source: 'session',
      trackId: 'stranger',
      movementState: 'entered',
      ...FRAME,
    })
    const out = ledger.observe({
      deviceId: DEV,
      className: 'vehicle',
      bbox: CAR_A,
      timestamp: T0 + 31 * 60_000 + 500,
      source: 'session',
      trackId: 'car-again',
      movementState: 'idle',
      ...FRAME,
    })
    expect(out?.promoted).toBe(true)
    expect(ledger.candidatesFor(DEV)).toHaveLength(0)
  })
})

describe('stationary evidence — a binding is class-bound', () => {
  it('a track whose class flipped stops feeding the row it bound under the old class', () => {
    const ledger = makeLedger()
    feed(ledger, [
      { bbox: CAR_A, at: T0, trackId: 'flip' },
      { bbox: CAR_A, at: T0 + 100, trackId: 'flip' },
    ])
    const vehicle = ledger.candidatesFor(DEV).find((r) => r.className === 'vehicle')!
    expect(vehicle.seen).toBe(2)
    feed(ledger, [{ bbox: CAR_A, at: T0 + 200, trackId: 'flip' }], 'person')
    const rows = ledger.candidatesFor(DEV)
    expect(rows.find((r) => r.className === 'vehicle')?.seen).toBe(2)
    expect(rows.find((r) => r.className === 'person')?.seen).toBe(1)
    expect(ledger.bindingsFor(DEV)).toEqual([{ trackId: 'flip', candidateKey: rows[1]!.key }])
  })
})

describe('stationary evidence — an artifact box never mints, and keeps its evidence', () => {
  /** 3836's jacket on its coat stand: 97 % of the frame height. */
  const JACKET: StationaryBbox = { x: 268, y: 0, w: 1132, h: 1396 }
  const STUDIO = { frameWidth: 2560, frameHeight: 1440 } as const

  it('the jacket: person evidence far past the policy, refused as implausible-box, kept', () => {
    const logger = makeSilentLogger()
    const info = vi.spyOn(logger, 'info')
    const ledger = new StationaryEvidenceLedger({
      records: makeAnalyticsRecordsNow().records,
      logger,
    })
    let promoted = false
    // 40 minutes of still sightings at 1 fps, one track per session.
    for (let i = 0; i < 2_400; i++) {
      const out = ledger.observe({
        deviceId: 3836,
        className: 'person',
        bbox: JACKET,
        timestamp: T0 + i * 1_000,
        source: 'session',
        trackId: `t${Math.floor(i / 300)}`,
        movementState: 'idle',
        ...STUDIO,
      })
      if (out?.promoted === true) promoted = true
    }
    expect(promoted).toBe(false)
    const row = ledger.candidatesFor(3836)[0]!
    expect(row.agreed).toBe(2_400)
    expect(evaluateStationaryEvidence(row, PERSON_EVIDENCE_POLICY, STUDIO)).toMatchObject({
      kind: 'accumulating',
      shortfall: 'implausible-box',
    })
    // Said once, not 2 400 times.
    const refusals = info.mock.calls.filter(([msg]) => String(msg).includes('implausible box'))
    expect(refusals).toHaveLength(1)
  })

  it('the same evidence on a plausible box promotes (control)', () => {
    const ledger = makeLedger()
    const box: StationaryBbox = { x: 1012, y: 379, w: 236, h: 568 }
    let promoted = false
    for (let i = 0; i < 2_400; i++) {
      const out = ledger.observe({
        deviceId: 3836,
        className: 'person',
        bbox: box,
        timestamp: T0 + i * 1_000,
        source: 'session',
        trackId: `t${Math.floor(i / 300)}`,
        movementState: 'idle',
        ...STUDIO,
      })
      if (out?.promoted === true) promoted = true
    }
    expect(promoted).toBe(true)
  })
})
