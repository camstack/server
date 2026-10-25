/**
 * "Not yet decided" is not a disagreement (D547).
 *
 * Measured on device 102, 2026-09-19 20:32 → 09-20 07:53: 21 vehicle tracks
 * bound to the DNRG309 candidate. Thirteen never reached `idle` — the motion
 * session closed before the 10 s dwell elapsed (0.0–15.9 s each) — and the
 * eight that did spent their first 10–20 s `entered`/settling. Counting every
 * one of those undecided observations in M gave the ledger a ratio of 0.493
 * against a bar of 0.6, and the car needed 11.3 h and 19 sessions to be
 * censused. Every one of those sessions minted a track, ~3.3 MB of media and
 * an `idle` event.
 *
 * The fixtures below are that measurement, compressed: short tracks that die
 * undecided, long tracks that decide `idle` after a settling prelude. The
 * assertion is the one the operator cares about — the car is censused on the
 * SECOND session that sees it still (the span rule is untouched), not the
 * nineteenth — and the two failure modes D508 measured stay refused: a car
 * that passes through, and a car that stops for a moment and leaves.
 */
import { makeAnalyticsRecordsNow } from '../../../__tests__/fake-records.js'
import { describe, expect, it } from 'vitest'

import { makeSilentLogger } from '../../../__tests__/test-helpers.js'
import {
  foldObservation,
  newEvidenceRow,
  observationVote,
  VEHICLE_EVIDENCE_POLICY,
  type StationaryObservation,
} from '../stationary-evidence.js'
import type { TrackState } from '@camstack/types'
import { StationaryEvidenceLedger } from '../stationary-evidence-ledger.js'
import type { StationaryBbox } from '../stationary-types.js'

const T0 = 1_789_850_000_000
const DEV = 102
const FRAME = { frameWidth: 3840, frameHeight: 2160 } as const
/** DNRG309's box on 102 (`a3dbf30e`), 0.025 of the frame. */
const CAR: StationaryBbox = { x: 3026, y: 346, w: 445, h: 405 }
/** The measured cadence of a 102 session track: ~125 ms between positions. */
const STEP_MS = 125

function makeLedger(): StationaryEvidenceLedger {
  return new StationaryEvidenceLedger({
    records: makeAnalyticsRecordsNow().records,
    logger: makeSilentLogger(),
  })
}

function jitter(box: StationaryBbox, i: number): StationaryBbox {
  const d = (i % 5) - 2
  return { x: box.x + d * 3, y: box.y + d * 2, w: box.w, h: box.h }
}

interface Sighting {
  readonly bbox: StationaryBbox
  readonly at: number
  readonly trackId: string
  readonly state: TrackState
  readonly settling: boolean
}

function feed(ledger: StationaryEvidenceLedger, sightings: readonly Sighting[]): boolean {
  let promoted = false
  for (const s of sightings) {
    const observation: StationaryObservation = {
      deviceId: DEV,
      className: 'vehicle',
      bbox: s.bbox,
      timestamp: s.at,
      source: 'session',
      trackId: s.trackId,
      movementState: s.state,
      settling: s.settling,
      ...FRAME,
    }
    const outcome = ledger.observe(observation)
    if (outcome?.promoted === true) promoted = true
  }
  return promoted
}

/**
 * One session-bounded track of a PARKED car, exactly as the analyzer reports
 * it: `enteringFrames` of `entered`, then `moving` frames on which the D539
 * settled test already passed but `stationaryThresholdSec` has not elapsed
 * (`settling: true`), then `idle` until the session closes. A track shorter
 * than the dwell never reaches the third phase.
 */
function parkedTrack(trackId: string, startAt: number, frames: number): Sighting[] {
  const out: Sighting[] = []
  for (let i = 0; i < frames; i++) {
    const state: TrackState = i < 5 ? 'entered' : i < 85 ? 'moving' : 'idle'
    out.push({
      bbox: jitter(CAR, i),
      at: startAt + i * STEP_MS,
      trackId,
      state,
      settling: state === 'moving',
    })
  }
  return out
}

/** A car that DRIVES THROUGH the spot: five `entered`, three `moving`, gone.
 *  The D508 case — 5/8 cleared the ratio when `entered` agreed. */
function passingTrack(trackId: string, startAt: number): Sighting[] {
  const out: Sighting[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      bbox: { x: CAR.x + i * 40, y: CAR.y, w: CAR.w, h: CAR.h },
      at: startAt + i * STEP_MS,
      trackId,
      state: i < 5 ? 'entered' : 'moving',
      settling: false,
    })
  }
  return out
}

describe('stationary evidence — an undecided observation is neither N nor M (D547)', () => {
  it('votes: idle agrees, entered and settling are undecided, travelling disagrees, a burst agrees', () => {
    const iou = VEHICLE_EVIDENCE_POLICY.agreeIou
    expect(observationVote(0.9, iou, 'session', 'idle', false)).toBe('agree')
    expect(observationVote(0.9, iou, 'session', 'entered', false)).toBe('undecided')
    expect(observationVote(0.9, iou, 'session', 'moving', true)).toBe('undecided')
    expect(observationVote(0.9, iou, 'session', 'moving', false)).toBe('disagree')
    expect(observationVote(0.9, iou, 'session', undefined, false)).toBe('disagree')
    expect(observationVote(0.9, iou, 'burst', undefined, false)).toBe('agree')
    // Identity first: a box somewhere else is a miss whatever its verdict.
    expect(observationVote(0.1, iou, 'session', 'idle', false)).toBe('disagree')
  })

  it('an undecided fold touches the candidate but counts toward neither N nor M', () => {
    const base: StationaryObservation = {
      deviceId: DEV,
      className: 'vehicle',
      bbox: CAR,
      timestamp: T0,
      source: 'session',
      trackId: 't1',
      movementState: 'idle',
      settling: false,
      ...FRAME,
    }
    const row = newEvidenceRow(base, 'a1')
    const next = foldObservation(
      row,
      { ...base, timestamp: T0 + STEP_MS, movementState: 'moving', settling: true },
      'undecided',
      1,
    )
    expect(next.agreed).toBe(row.agreed)
    expect(next.seen).toBe(row.seen)
    expect(next.windowSeen).toBe(row.windowSeen)
    expect(next.undecided).toBe(row.undecided + 1)
    expect(next.updatedAt).toBe(T0 + STEP_MS)
  })

  it('the DNRG309 profile: short undecided tracks no longer dilute — censused on the second still session', () => {
    const ledger = makeLedger()
    // Session 1 (36 s): the car is decided `idle` for its last 22 s.
    let promoted = feed(ledger, parkedTrack('s1', T0, 280))
    expect(promoted).toBe(false) // span-too-short: one session cannot stretch 120 s
    // Six sessions cut short by a passer-by — the car is seen, never decided.
    // Measured: 13 of 21 bound tracks on 102 never reached `idle`.
    const shortLengths = [2, 2, 52, 28, 4, 34]
    shortLengths.forEach((frames, i) => {
      promoted = feed(ledger, parkedTrack(`short${i}`, T0 + (i + 1) * 60_000, frames)) || promoted
    })
    expect(promoted).toBe(false)
    // Session 2, ten minutes after the first: the car decides `idle` again.
    promoted = feed(ledger, parkedTrack('s2', T0 + 10 * 60_000, 280))
    expect(promoted).toBe(true)
  })

  it('still refuses a car that DRIVES THROUGH — entered is undecided, travelling disagrees, nothing agrees', () => {
    const ledger = makeLedger()
    let promoted = false
    for (let i = 0; i < 20; i++) {
      promoted = feed(ledger, passingTrack(`p${i}`, T0 + i * 30_000)) || promoted
    }
    expect(promoted).toBe(false)
  })

  it('still refuses a MOMENTARY stop — settling that never matures earns no agreement', () => {
    const ledger = makeLedger()
    let promoted = false
    // Sixty stops of 8 s each (64 frames: 5 entered + 59 settling), never idle.
    for (let i = 0; i < 60; i++) {
      promoted = feed(ledger, parkedTrack(`m${i}`, T0 + i * 30_000, 64)) || promoted
    }
    expect(promoted).toBe(false)
  })
})
