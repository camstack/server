import { describe, expect, it } from 'vitest'
import {
  type CalibrationTrack,
  calibrateStillnessSpeed,
  collectStillnessSamples,
  DEFAULT_STILLNESS_CALIBRATION_LIMITS,
} from '../stillness-scale.js'

/** A straight-line track at a constant speed, sampled every `stepMs`. */
function movingTrack(
  trackId: string,
  opts: {
    readonly pxPerStep: number
    readonly stepMs: number
    readonly steps: number
    readonly boxW: number
    readonly boxH: number
    readonly t0?: number
  },
): CalibrationTrack {
  const positions = []
  for (let i = 0; i < opts.steps; i++) {
    positions.push({
      x: 100 + i * opts.pxPerStep,
      y: 100,
      timestamp: (opts.t0 ?? 0) + i * opts.stepMs,
      bbox: { w: opts.boxW, h: opts.boxH },
    })
  }
  return { trackId, className: 'person', positions }
}

function manyTracks(count: number, pxPerStep: number, steps = 40): readonly CalibrationTrack[] {
  return Array.from({ length: count }, (_, i) =>
    movingTrack(`t${i}`, { pxPerStep, stepMs: 100, steps, boxW: 60, boxH: 80 }),
  )
}

describe('collectStillnessSamples', () => {
  it('measures centroid speed as a fraction of the subject box diagonal per second', () => {
    // 10 px per 100 ms = 100 px/s; box diagonal = hypot(60,80) = 100 px.
    const samples = collectStillnessSamples(
      [movingTrack('a', { pxPerStep: 10, stepMs: 100, steps: 5, boxW: 60, boxH: 80 })],
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(samples.trackCount).toBe(1)
    expect(samples.speeds).toHaveLength(4)
    for (const s of samples.speeds) expect(s).toBeCloseTo(1.0, 6)
  })

  it('drops intervals outside the sampling bounds instead of inventing a speed', () => {
    const t: CalibrationTrack = {
      trackId: 'gap',
      className: 'person',
      positions: [
        { x: 0, y: 0, timestamp: 0, bbox: { w: 60, h: 80 } },
        // 10 s gap — a session boundary, not a movement measurement.
        { x: 500, y: 0, timestamp: 10_000, bbox: { w: 60, h: 80 } },
        { x: 510, y: 0, timestamp: 10_100, bbox: { w: 60, h: 80 } },
      ],
    }
    const samples = collectStillnessSamples([t], DEFAULT_STILLNESS_CALIBRATION_LIMITS)
    expect(samples.speeds).toHaveLength(1)
  })

  it('ignores a position with no usable box — unknown geometry is not a sample', () => {
    const t: CalibrationTrack = {
      trackId: 'degenerate',
      className: 'person',
      positions: [
        { x: 0, y: 0, timestamp: 0, bbox: { w: 0, h: 0 } },
        { x: 10, y: 0, timestamp: 100, bbox: { w: 0, h: 0 } },
      ],
    }
    expect(collectStillnessSamples([t], DEFAULT_STILLNESS_CALIBRATION_LIMITS).speeds).toHaveLength(
      0,
    )
  })

  it('reads at most `maxTracks` tracks — the pass is cost-bounded', () => {
    const limits = { ...DEFAULT_STILLNESS_CALIBRATION_LIMITS, maxTracks: 3 }
    const samples = collectStillnessSamples(manyTracks(50, 10), limits)
    expect(samples.trackCount).toBe(3)
  })
})

describe('calibrateStillnessSpeed — refusals', () => {
  it('refuses with `no-tracks` when the camera has recorded nothing', () => {
    const out = calibrateStillnessSpeed(
      collectStillnessSamples([], DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('no-tracks')
  })

  it('refuses with `too-few-tracks` rather than inventing a bar from four tracks', () => {
    const samples = collectStillnessSamples(manyTracks(4, 10, 200), {
      ...DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    })
    // Deliberately plenty of SAMPLES — the track count is the gate that fires.
    expect(samples.speeds.length).toBeGreaterThan(DEFAULT_STILLNESS_CALIBRATION_LIMITS.minSamples)
    const out = calibrateStillnessSpeed(samples, DEFAULT_STILLNESS_CALIBRATION_LIMITS)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('too-few-tracks')
  })

  it('refuses with `too-few-samples` when many tracks carry almost no trajectory', () => {
    const tracks = Array.from({ length: 20 }, (_, i) =>
      movingTrack(`s${i}`, { pxPerStep: 10, stepMs: 100, steps: 2, boxW: 60, boxH: 80 }),
    )
    const out = calibrateStillnessSpeed(
      collectStillnessSamples(tracks, DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('too-few-samples')
  })

  it('refuses with `no-motion-evidence` when nothing on this camera ever moved', () => {
    const tracks = Array.from({ length: 20 }, (_, i) =>
      movingTrack(`z${i}`, { pxPerStep: 0, stepMs: 100, steps: 40, boxW: 60, boxH: 80 }),
    )
    const out = calibrateStillnessSpeed(
      collectStillnessSamples(tracks, DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('no-motion-evidence')
  })
})

describe('calibrateStillnessSpeed — what it chooses', () => {
  /**
   * The two cameras in the operator's sentence. Measured on the live hub
   * 2026-09-19 (60 recent tracks each): device 101 (a far view whose subjects
   * only ever transit) sits at p50 0.308 subject-diagonals/s, device 107 (a
   * close view full of parked subjects) at p50 0.0136 — a 23x spread AFTER
   * normalising by the subject's own box. One number cannot be right for both.
   */
  it('gives a fast camera a looser bar than a slow one, from their own data', () => {
    const fast = calibrateStillnessSpeed(
      collectStillnessSamples(manyTracks(20, 40), DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    const slow = calibrateStillnessSpeed(
      collectStillnessSamples(manyTracks(20, 2), DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(fast.ok).toBe(true)
    expect(slow.ok).toBe(true)
    if (fast.ok && slow.ok) expect(fast.bar).toBeGreaterThan(slow.bar * 5)
  })

  it('lifts a bar off zero on a camera whose subjects mostly park, using its OWN travel speed', () => {
    // 15 parked tracks (speed 0) + 5 transits. The quantile lands on zero; the
    // floor is a fraction of what this camera's own movers do, never an
    // imported absolute number.
    const parked = Array.from({ length: 15 }, (_, i) =>
      movingTrack(`p${i}`, { pxPerStep: 0, stepMs: 100, steps: 40, boxW: 60, boxH: 80 }),
    )
    const movers = Array.from({ length: 5 }, (_, i) =>
      movingTrack(`m${i}`, { pxPerStep: 20, stepMs: 100, steps: 40, boxW: 60, boxH: 80 }),
    )
    const out = calibrateStillnessSpeed(
      collectStillnessSamples([...parked, ...movers], DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.bar).toBeGreaterThan(0)
      expect(out.clampedBy).toBe('floor')
      expect(out.measurement.p90).toBeGreaterThan(0)
    }
  })

  it('never lets a camera with no still subject silence its own walkers', () => {
    // Every track transits at the same speed, so the quantile IS the travel
    // speed. The ceiling caps the bar well below it.
    const out = calibrateStillnessSpeed(
      collectStillnessSamples(manyTracks(20, 30), DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.clampedBy).toBe('ceiling')
      expect(out.bar).toBeLessThan(out.measurement.p50)
    }
  })

  it('reports what it measured and from how many samples', () => {
    const out = calibrateStillnessSpeed(
      collectStillnessSamples(manyTracks(20, 10), DEFAULT_STILLNESS_CALIBRATION_LIMITS),
      DEFAULT_STILLNESS_CALIBRATION_LIMITS,
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.measurement.trackCount).toBe(20)
      expect(out.measurement.sampleCount).toBe(20 * 39)
      expect(out.measurement.medianIntervalSec).toBeCloseTo(0.1, 6)
      expect(out.measurement.medianSubjectDiagonalPx).toBeCloseTo(100, 6)
    }
  })
})
