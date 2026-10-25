/**
 * `resolveDenseCadence` — how fast the timelapse samples INSIDE a dense range.
 *
 * The operator's arithmetic, which every case here is a point on: a range's
 * OUTPUT seconds are `(rangeSec / denseCadenceSec) / outputFps`. A 7 s person
 * pass at a 1 s dense cadence rendered at 12 fps is 7 frames ≈ 0.58 s of video
 * — visible, but barely. `minDwellSec` is the operator asking for a floor on
 * that number, and this module is the only place it is computed.
 */

import { describe, expect, it } from 'vitest'
import {
  DENSE_CADENCE_DIVISOR,
  resolveDenseCadence,
  TIMELAPSE_DENSE_FLOOR_MS,
} from '../dense-cadence.js'

/** One 7 s pass — the operator's exact scenario, in range coordinates. */
const PASS_7S = [{ fromSec: 600, toSec: 607 }] as const

describe('resolveDenseCadence — default derivation', () => {
  it('derives base/30 floored at 1 s — a 30 s base now samples every 1 s', () => {
    // The OLD derivation was base/10 = 3 s, which rendered the operator's 7 s
    // pass as 2 frames. This is the approved change, and the number that must
    // appear in the export input.
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      outputFps: 12,
      ranges: PASS_7S,
    })
    expect(decision.everyMs).toBe(1000)
    expect(decision.source).toBe('default')
  })

  it('keeps the two rates visibly apart at a long base (300 s → 10 s)', () => {
    const decision = resolveDenseCadence({ cadenceSec: 300, outputFps: 12, ranges: PASS_7S })
    expect(decision.everyMs).toBe(10_000)
  })

  it('floors the derivation at 1 s so a short base never derives sub-second', () => {
    // 15 s / 30 = 0.5 s, below the 1 s derivation floor.
    const decision = resolveDenseCadence({ cadenceSec: 15, outputFps: 12, ranges: PASS_7S })
    expect(decision.everyMs).toBe(1000)
  })

  it('divides by 30, not by 10', () => {
    expect(DENSE_CADENCE_DIVISOR).toBe(30)
  })

  it('stays strictly denser than the base at the smallest usable base', () => {
    // base 2 s → derivation floor 1 s, which must still be STRICTLY smaller.
    const decision = resolveDenseCadence({ cadenceSec: 2, outputFps: 12, ranges: PASS_7S })
    expect(decision.everyMs).toBe(1000)
    expect(decision.everyMs).toBeLessThan(2000)
  })
})

describe('resolveDenseCadence — explicit override', () => {
  it('honours an explicit denseCadenceSec instead of deriving', () => {
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      denseCadenceSec: 0.5,
      outputFps: 12,
      ranges: PASS_7S,
    })
    expect(decision.everyMs).toBe(500)
    expect(decision.source).toBe('explicit')
  })

  it('clamps an override below the recording frame interval to the 0.1 s floor', () => {
    // Upsert refuses this, but the resolver is defensive: a rule persisted
    // before the guard, or a hand-edited row, must not ask for frames that do
    // not exist.
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      denseCadenceSec: 0.01,
      outputFps: 12,
      ranges: PASS_7S,
    })
    expect(decision.everyMs).toBe(TIMELAPSE_DENSE_FLOOR_MS)
    expect(TIMELAPSE_DENSE_FLOOR_MS).toBe(100)
  })
})

describe('resolveDenseCadence — minDwellSec', () => {
  it('densifies until the operator’s 7 s pass fills minDwell seconds of output', () => {
    // The scenario, verbatim: 7 s pass, base 30 s, 12 fps, "hold it a second".
    const minDwellSec = 1
    const outputFps = 12
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      minDwellSec,
      outputFps,
      ranges: PASS_7S,
    })
    // The guarantee, asserted as the operator states it — output seconds, not
    // an intermediate cadence.
    const frames = Math.floor(7000 / decision.everyMs)
    const outputSeconds = frames / outputFps
    expect(outputSeconds).toBeGreaterThanOrEqual(minDwellSec)
    expect(decision.dwellApplied).toBe(true)
    expect(decision.dwellFloorCapped).toBe(false)
  })

  it('never SPARSENS — a cadence already meeting minDwell is left alone', () => {
    // 60 s range at the derived 1 s cadence is 60 frames = 5 s at 12 fps,
    // already past a 2 s dwell. Densifying further would only cost frames.
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      minDwellSec: 2,
      outputFps: 12,
      ranges: [{ fromSec: 0, toSec: 60 }],
    })
    expect(decision.everyMs).toBe(1000)
    expect(decision.dwellApplied).toBe(false)
  })

  it('takes the MOST DEMANDING range — one cadence has to serve them all', () => {
    // The 3 s range needs 3/(1*12) = 0.25 s; the 60 s range needs nothing.
    // Global `dense.everyMs` means the shorter range sets the rate.
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      minDwellSec: 1,
      outputFps: 12,
      ranges: [
        { fromSec: 0, toSec: 60 },
        { fromSec: 100, toSec: 103 },
      ],
    })
    expect(decision.everyMs).toBe(250)
    const shortFrames = Math.floor(3000 / decision.everyMs)
    expect(shortFrames / 12).toBeGreaterThanOrEqual(1)
  })

  it('caps a too-short range at the frames that EXIST rather than duplicating', () => {
    // A 0.5 s range cannot fill 2 s of output at 12 fps: that would need 24
    // frames from half a second of footage. The floor stops the densification
    // and the decision SAYS so — a duplicated frame would be an invented one.
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      minDwellSec: 2,
      outputFps: 12,
      ranges: [{ fromSec: 10, toSec: 10.5 }],
    })
    expect(decision.everyMs).toBe(TIMELAPSE_DENSE_FLOOR_MS)
    expect(decision.dwellFloorCapped).toBe(true)
    const frames = Math.floor(500 / decision.everyMs)
    expect(frames).toBe(5)
    expect(frames / 12).toBeLessThan(2)
  })

  it('combines an explicit override with minDwell — dwell may only densify it', () => {
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      denseCadenceSec: 2,
      minDwellSec: 1,
      outputFps: 12,
      ranges: PASS_7S,
    })
    // 2 s would give 3 frames = 0.25 s; dwell pulls it to 7/(1*12) ≈ 583 ms.
    expect(decision.everyMs).toBe(583)
    expect(decision.dwellApplied).toBe(true)
  })

  it('ignores minDwell when there are no dense ranges at all', () => {
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      minDwellSec: 5,
      outputFps: 12,
      ranges: [],
    })
    expect(decision.everyMs).toBe(1000)
    expect(decision.dwellApplied).toBe(false)
  })

  it('always yields an INTEGER ms the cap schema can carry', () => {
    const decision = resolveDenseCadence({
      cadenceSec: 30,
      minDwellSec: 1,
      outputFps: 7,
      ranges: [{ fromSec: 0, toSec: 5 }],
    })
    expect(Number.isInteger(decision.everyMs)).toBe(true)
  })
})
