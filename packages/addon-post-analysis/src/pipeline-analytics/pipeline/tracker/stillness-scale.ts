/**
 * stillness-scale — the per-camera SCALE behind "has this subject settled".
 *
 * ## Why a camera needs its own number
 *
 * `StateAnalyzer.velocityThreshold` is 2 px per tracker update, the same on
 * every camera. It cannot be. Measured on the live hub on 2026-09-19, 60 recent
 * tracks per camera, per-sample centroid speed:
 *
 * | device | px/s p50 | px/s p90 | subject-diagonals/s p50 | subject-diagonals/s p90 |
 * | --- | --- | --- | --- | --- |
 * | 592 | 23.4 | 265.5 | 0.0136 | 0.1367 |
 * | 101 | 212.1 | 741.0 | 0.3081 | 1.0088 |
 * | 102 | 12.1 | 187.7 | 0.0201 | 0.3098 |
 * | 618 | 75.7 | 568.5 | 0.0611 | 0.4132 |
 *
 * An **18x** spread in raw pixels — the D394 lesson, again: an absolute pixel
 * count means a different thing on every camera. Normalising by the subject's
 * OWN box diagonal (which is what `windowSaysStill` already does, and why that
 * one needs no dial) narrows it to **23x**, which is still not one number.
 * Perspective explains the pixels; the camera's cadence, its jitter and what it
 * actually watches explain the rest. Only the camera's own recorded motion can
 * say where its "not travelling" line falls.
 *
 * ## What is calibrated, and in what units
 *
 * ONE scalar: centroid speed as a fraction of the SUBJECT's own box diagonal
 * per SECOND. Subject-relative so perspective is already divided out (a person
 * 30 m down a driveway has a small box AND small pixel motion); per SECOND so a
 * camera's irregular `armed:on-motion` cadence — 56 ms to 2135 ms between
 * stored positions on one subject (D399) — cannot masquerade as speed.
 *
 * ## How the bar is chosen
 *
 * `quantile` (0.25) of the camera's own per-sample speeds, then clamped into
 * `[p90 * floorFactor, p90 * ceilFactor]`. Both clamps are expressed against
 * the SAME camera's travelling speed, so no foreign absolute number ever enters:
 *
 * - The **floor** exists because a camera full of parked subjects has a p25 of
 *   exactly 0 (592 and 102 above), and a bar of zero means nothing is ever
 *   still. It lifts the bar to a small fraction of what this camera's movers do.
 * - The **ceiling** exists because a camera whose subjects only ever transit
 *   (101) has a p25 that IS a walking pace, and adopting it would label every
 *   walker settled. It caps the bar well under the camera's own travel.
 *
 * ## Why it refuses
 *
 * A threshold invented from four tracks is worse than the default: it is a
 * number with the authority of a measurement and the content of a coin flip.
 * Every refusal is NAMED and carries what it did measure, so "why is this
 * camera still on the default" is answerable without re-running anything.
 *
 * Pure: no store, no clock, no I/O. The caller bounds the read and supplies the
 * tracks.
 */

/** One stored position, reduced to what the scale is measured from. */
export interface CalibrationPosition {
  readonly x: number
  readonly y: number
  readonly timestamp: number
  readonly bbox: { readonly w: number; readonly h: number }
}

/** One recorded track. `positions` need not be sorted — this module sorts. */
export interface CalibrationTrack {
  readonly trackId: string
  readonly className: string
  readonly positions: readonly CalibrationPosition[]
}

export interface StillnessCalibrationLimits {
  /** Below this many CONTRIBUTING tracks the pass refuses. */
  readonly minTracks: number
  /** Below this many speed samples the pass refuses. */
  readonly minSamples: number
  /** Hard cost bound: tracks read, newest first. */
  readonly maxTracks: number
  /** Intervals shorter than this are duplicate/near-simultaneous reads. */
  readonly minIntervalSec: number
  /** Intervals longer than this span a session boundary, not a movement. */
  readonly maxIntervalSec: number
  /** Quantile of the speed distribution taken as the raw bar. */
  readonly quantile: number
  /** Floor, as a fraction of the camera's own p90 speed. */
  readonly floorFactor: number
  /** Ceiling, as a fraction of the camera's own p90 speed. */
  readonly ceilFactor: number
  /** Absolute sanity rails on the stored value (subject-diagonals per second). */
  readonly minBar: number
  readonly maxBar: number
}

/** Absolute rails on a stored bar (subject-diagonals per second). Shared with
 *  `stillness-settings.ts` so the schema and the calibration can never disagree
 *  about what is a possible value. */
export const STILLNESS_BAR_MIN = 0.001
export const STILLNESS_BAR_MAX = 1

/**
 * The shipped limits.
 *
 * `minTracks` 12 / `minSamples` 200: the four live cameras sampled above
 * produced 697–8739 samples from 42–51 tracks in a single 60-track read, so a
 * camera that cannot clear these has genuinely not been watched enough.
 * `maxTracks` 200 bounds the read: the `positions` blob averages ~10 kB a row
 * (`track-store.ts`), so this pass is ~2 MB of JSON at its worst.
 */
export const DEFAULT_STILLNESS_CALIBRATION_LIMITS: StillnessCalibrationLimits = {
  minTracks: 12,
  minSamples: 200,
  maxTracks: 200,
  minIntervalSec: 0.02,
  maxIntervalSec: 3,
  quantile: 0.25,
  floorFactor: 0.02,
  ceilFactor: 0.25,
  minBar: STILLNESS_BAR_MIN,
  maxBar: STILLNESS_BAR_MAX,
}

export interface StillnessSamples {
  /** Centroid speed, subject-box-diagonals per second, one per usable interval. */
  readonly speeds: readonly number[]
  /** The intervals those speeds were measured over (seconds). */
  readonly intervals: readonly number[]
  /** Subject box diagonals (px) the speeds were normalised by. */
  readonly diagonals: readonly number[]
  /** Tracks that contributed at least one sample. */
  readonly trackCount: number
  /** Tracks the pass looked at, after `maxTracks`. */
  readonly tracksRead: number
}

/** What the pass measured, reported whether it chose a bar or refused. */
export interface StillnessCalibrationMeasurement {
  readonly trackCount: number
  readonly sampleCount: number
  readonly p25: number
  readonly p50: number
  readonly p90: number
  readonly medianIntervalSec: number
  readonly medianSubjectDiagonalPx: number
}

export type StillnessCalibrationRefusal =
  | 'no-tracks'
  | 'too-few-tracks'
  | 'too-few-samples'
  | 'no-motion-evidence'

/** Which rail decided the stored value — so the readout states the RULE. */
export type StillnessCalibrationClamp = 'none' | 'floor' | 'ceiling' | 'min' | 'max'

export interface StillnessCalibrationAccepted {
  readonly ok: true
  /** Subject-box-diagonals per second. */
  readonly bar: number
  /** The raw quantile before the rails, so the clamp is arguable. */
  readonly rawBar: number
  readonly clampedBy: StillnessCalibrationClamp
  readonly measurement: StillnessCalibrationMeasurement
}

export interface StillnessCalibrationRefused {
  readonly ok: false
  readonly reason: StillnessCalibrationRefusal
  readonly measurement: StillnessCalibrationMeasurement
}

export type StillnessCalibrationOutcome = StillnessCalibrationAccepted | StillnessCalibrationRefused

/** Linear-interpolated quantile. `NaN` for an empty list — never 0, which
 *  would read as a measured zero (D393). */
function quantileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * Math.min(Math.max(p, 0), 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  const at = sorted[lo]
  const next = sorted[hi]
  if (at === undefined || next === undefined) return Number.NaN
  return at + (next - at) * (idx - lo)
}

/**
 * Per-sample centroid speeds for a camera, in subject-box-diagonals per second.
 *
 * A pair of consecutive positions contributes a sample only when the interval
 * between them is inside `[minIntervalSec, maxIntervalSec]` and the later box
 * has a positive diagonal. A gap outside that band is a session boundary or a
 * duplicate read, not a measurement of how fast anything travelled; a box with
 * no size is unknown geometry, and unknown is never a sample.
 */
export function collectStillnessSamples(
  tracks: readonly CalibrationTrack[],
  limits: StillnessCalibrationLimits,
): StillnessSamples {
  const speeds: number[] = []
  const intervals: number[] = []
  const diagonals: number[] = []
  let trackCount = 0
  const read = tracks.slice(0, limits.maxTracks)

  for (const track of read) {
    const positions = [...track.positions].sort((a, b) => a.timestamp - b.timestamp)
    let contributed = false
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1]
      const cur = positions[i]
      if (prev === undefined || cur === undefined) continue
      const dtSec = (cur.timestamp - prev.timestamp) / 1000
      if (dtSec < limits.minIntervalSec || dtSec > limits.maxIntervalSec) continue
      const diagonal = Math.hypot(cur.bbox.w, cur.bbox.h)
      if (!(diagonal > 0)) continue
      const travelled = Math.hypot(cur.x - prev.x, cur.y - prev.y)
      speeds.push(travelled / diagonal / dtSec)
      intervals.push(dtSec)
      diagonals.push(diagonal)
      contributed = true
    }
    if (contributed) trackCount++
  }

  return { speeds, intervals, diagonals, trackCount, tracksRead: read.length }
}

function measure(samples: StillnessSamples): StillnessCalibrationMeasurement {
  return {
    trackCount: samples.trackCount,
    sampleCount: samples.speeds.length,
    p25: quantileOf(samples.speeds, 0.25),
    p50: quantileOf(samples.speeds, 0.5),
    p90: quantileOf(samples.speeds, 0.9),
    medianIntervalSec: quantileOf(samples.intervals, 0.5),
    medianSubjectDiagonalPx: quantileOf(samples.diagonals, 0.5),
  }
}

/**
 * Choose this camera's stillness speed bar, or refuse with a named reason.
 *
 * The order of the gates is the order of the questions: is there anything at
 * all, is it enough tracks, is it enough samples, and did anything on this
 * camera ever actually move. The last one is not pedantry — the whole method
 * scales the bar against the camera's own travel, so with no travel there is
 * nothing to scale against and the default is the honest answer.
 */
export function calibrateStillnessSpeed(
  samples: StillnessSamples,
  limits: StillnessCalibrationLimits,
): StillnessCalibrationOutcome {
  const measurement = measure(samples)

  if (samples.tracksRead === 0) return { ok: false, reason: 'no-tracks', measurement }
  if (samples.trackCount < limits.minTracks)
    return { ok: false, reason: 'too-few-tracks', measurement }
  if (samples.speeds.length < limits.minSamples)
    return { ok: false, reason: 'too-few-samples', measurement }
  if (!(measurement.p90 > 0)) return { ok: false, reason: 'no-motion-evidence', measurement }

  const rawBar = quantileOf(samples.speeds, limits.quantile)
  const floor = measurement.p90 * limits.floorFactor
  const ceiling = measurement.p90 * limits.ceilFactor

  let bar = rawBar
  let clampedBy: StillnessCalibrationClamp = 'none'
  if (bar < floor) {
    bar = floor
    clampedBy = 'floor'
  } else if (bar > ceiling) {
    bar = ceiling
    clampedBy = 'ceiling'
  }
  if (bar < limits.minBar) {
    bar = limits.minBar
    clampedBy = 'min'
  } else if (bar > limits.maxBar) {
    bar = limits.maxBar
    clampedBy = 'max'
  }

  return { ok: true, bar, rawBar, clampedBy, measurement }
}

/** One line an operator can read: what was measured, from how much, and what
 *  rule produced the stored number. Kept short — it rides the settings blob. */
export function describeStillnessCalibration(outcome: StillnessCalibrationOutcome): string {
  const m = outcome.measurement
  const n = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : 'unknown')
  const evidence = `${m.sampleCount} samples / ${m.trackCount} tracks, p25 ${n(m.p25)}, p50 ${n(m.p50)}, p90 ${n(m.p90)} subject-diagonals/s`
  if (!outcome.ok) return `refused (${outcome.reason}) — ${evidence}`
  return `bar ${n(outcome.bar)} (raw ${n(outcome.rawBar)}, clamp ${outcome.clampedBy}) — ${evidence}`
}
