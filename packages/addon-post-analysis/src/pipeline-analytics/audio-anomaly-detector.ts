// ---------------------------------------------------------------------------
// audio-anomaly-detector — per-camera "is this sound out of the ordinary,
// FOR THIS CAMERA" decision. Pure, O(1), no allocation. The caller keeps one
// AudioBaselineState per device and feeds it EVERY audio frame's dBFS.
//
// Why not reuse `audio-level-detector`'s rolling window: that one keeps an
// array of every sample in a 10 s window and re-filters + re-reduces it on
// every frame (~300 samples × 30 Hz × N cameras), and its baseline only sees
// the frames the LEVEL route reaches — a confidently classified bark never
// updates it. This one is fed before the route split, is O(1) per frame, and
// answers a different question: `observeLevel` asks "is this a peak" (a fixed
// dB step over a 10 s mean), this asks "is this SURPRISING", in units of the
// camera's own measured jitter.
//
// Three independent bars, and each exists because the other two do not catch
// its failure:
//   1. ABSOLUTE (`minDbfs`) — "high volume". A +20 dB jump from -60 to -40 is
//      extraordinary and inaudible; without this bar a silent camera's every
//      creak is a marker.
//   2. RELATIVE IN dB (`minDeviationDb`) — a floor on how far above its own
//      normal a sample must sit. Holds when the camera is so steady that its
//      MAD collapses to ~0 and the MAD test would pass on any nudge.
//   3. RELATIVE IN MADs (`minDeviations`) — the actual "out of the ordinary".
//      A camera on a busy road has a jittery floor and needs a bigger jump to
//      be surprising than a camera in a garden. An absolute-only rule cannot
//      express that, which is the whole reason this file exists.
//
// The baseline learns from EVERY frame, including the anomalous ones and the
// silent ones. That is deliberate on both counts: a camera whose normal is
// silence should have a silent normal, and a sound that becomes CONTINUOUS
// (roadworks, rain) should stop being a marker after a few minutes rather
// than firing forever. A one-off spike moves a 5-minute time constant by a
// negligible fraction, so it does not blind the detector to the next one.
// ---------------------------------------------------------------------------

/**
 * Minimum number of samples before a verdict other than `warmup` is possible,
 * independent of elapsed time. Guards a camera that delivers audio at a
 * fraction of a hertz: one full time constant could otherwise elapse over
 * three samples, and a 3-sample mean is not a camera's "normal".
 */
export const AUDIO_ANOMALY_MIN_SAMPLES = 30

/**
 * A baseline whose last sample is older than `baselineMs × this` no longer
 * describes the camera — an on-motion camera detaches for hours and comes
 * back to a different scene. Decaying it forward would make the first frame
 * back either a guaranteed marker (mean still holds the old quiet) or a
 * guaranteed miss; discarding it is the honest option and costs one warm-up.
 */
const STALE_BASELINE_FACTOR = 5

/**
 * Floor on the MAD used as the deviation unit, in dB. A perfectly flat signal
 * has MAD 0 and would make every deviation infinite. 1 dB is below the
 * quantisation of any real level meter, so it only ever binds on a synthetic
 * or a genuinely dead-steady signal — where bar 2 is what should decide.
 *
 * A floor on a DEVIATION, not on a level: scale-invariant, untouched by D459.
 *
 * @dbfs-era relative
 */
const MIN_MAD_DB = 1

export interface AudioAnomalyConfig {
  /** EWMA time constant for the camera's "normal", in ms. */
  readonly baselineMs: number
  /** dBFS at or below which a frame is silence and can never be a marker. */
  readonly silenceFloorDbfs: number
  /** Absolute "high volume" bar in dBFS. */
  readonly minDbfs: number
  /** How many MADs above its own mean a sample must sit. */
  readonly minDeviations: number
  /** Floor, in dB, on the distance above the mean (holds when MAD → 0). */
  readonly minDeviationDb: number
}

export interface AudioAnomalySample {
  readonly timestampMs: number
  readonly dbfs: number
}

/** O(1) per-camera baseline. Six numbers; no arrays, no allocation per frame. */
export interface AudioBaselineState {
  readonly count: number
  /** Time-aware EWMA of dBFS — the camera's "normal". */
  readonly mean: number
  /** Time-aware EWMA of |dbfs − mean| — the camera's own jitter, in dB. */
  readonly mad: number
  /** Timestamp of the first sample of the CURRENT baseline (reset on stale). */
  readonly firstMs: number
  /** Timestamp of the most recent sample. */
  readonly lastMs: number
}

/**
 * Why a frame is or is not a marker candidate. Every non-`anomalous` value is
 * a suppression the caller COUNTS — a threshold question always arrives as
 * "why did 102 fire and 101 not", and it cannot be answered from silence.
 */
export type AudioAnomalyVerdict =
  | { readonly kind: 'silent' }
  | { readonly kind: 'warmup' }
  | { readonly kind: 'not-loud'; readonly dbfs: number }
  | {
      readonly kind: 'not-anomalous'
      readonly dbfs: number
      readonly mean: number
      readonly deviationDb: number
      readonly deviations: number
    }
  | {
      readonly kind: 'anomalous'
      readonly dbfs: number
      readonly mean: number
      readonly deviationDb: number
      readonly deviations: number
    }

export interface AudioAnomalyResult {
  readonly verdict: AudioAnomalyVerdict
  readonly nextState: AudioBaselineState
}

export function emptyAudioBaseline(): AudioBaselineState {
  return { count: 0, mean: 0, mad: 0, firstMs: 0, lastMs: 0 }
}

/** Seed a fresh baseline from one sample (first ever, or after a stale gap). */
function seed(sample: AudioAnomalySample): AudioBaselineState {
  return {
    count: 1,
    mean: sample.dbfs,
    mad: 0,
    firstMs: sample.timestampMs,
    lastMs: sample.timestampMs,
  }
}

/**
 * Fold `sample` into `state` and decide whether it is a marker candidate.
 *
 * The verdict is measured against the PRIOR baseline (this frame excluded) so
 * a lone spike is not diluted by itself — the same reasoning
 * `audio-level-detector` uses for its `priorMean`. The state returned always
 * includes the sample, whatever the verdict.
 */
export function observeAudioAnomaly(
  state: AudioBaselineState,
  sample: AudioAnomalySample,
  cfg: AudioAnomalyConfig,
): AudioAnomalyResult {
  const isFirst = state.count === 0
  const gapMs = sample.timestampMs - state.lastMs
  const isStale = !isFirst && gapMs > cfg.baselineMs * STALE_BASELINE_FACTOR
  if (isFirst || isStale) {
    return { verdict: { kind: 'warmup' }, nextState: seed(sample) }
  }

  // Time-aware EWMA: correct for an irregular frame cadence, and identical to
  // the fixed-alpha form when the cadence is steady.
  const dt = Math.max(0, gapMs)
  const alpha = 1 - Math.exp(-dt / cfg.baselineMs)
  const priorMean = state.mean
  const priorMad = state.mad
  const nextState: AudioBaselineState = {
    count: state.count + 1,
    mean: priorMean + alpha * (sample.dbfs - priorMean),
    mad: priorMad + alpha * (Math.abs(sample.dbfs - priorMean) - priorMad),
    firstMs: state.firstMs,
    lastMs: sample.timestampMs,
  }

  if (sample.dbfs <= cfg.silenceFloorDbfs) {
    return { verdict: { kind: 'silent' }, nextState }
  }

  const warm =
    nextState.count >= AUDIO_ANOMALY_MIN_SAMPLES &&
    sample.timestampMs - state.firstMs >= cfg.baselineMs
  if (!warm) return { verdict: { kind: 'warmup' }, nextState }

  if (sample.dbfs < cfg.minDbfs) {
    return { verdict: { kind: 'not-loud', dbfs: sample.dbfs }, nextState }
  }

  const deviationDb = sample.dbfs - priorMean
  const deviations = deviationDb / Math.max(priorMad, MIN_MAD_DB)
  const measured = { dbfs: sample.dbfs, mean: priorMean, deviationDb, deviations }
  const surprising = deviationDb >= cfg.minDeviationDb && deviations >= cfg.minDeviations
  return {
    verdict: surprising
      ? { kind: 'anomalous', ...measured }
      : { kind: 'not-anomalous', ...measured },
    nextState,
  }
}
