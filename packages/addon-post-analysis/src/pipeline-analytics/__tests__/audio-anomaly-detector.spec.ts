/**
 * Per-camera audio anomaly baseline (D62).
 *
 * "Out of the ordinary" is measured against the CAMERA'S OWN normal, never an
 * absolute — a busy street whose floor is -30 dBFS must not raise a marker on
 * the level a quiet garden would call extraordinary. The baseline is an
 * O(1) time-aware EWMA of dBFS plus an EWMA of its mean absolute deviation,
 * so the bar is "how surprising is this FOR THIS CAMERA", in MADs.
 *
 * Covers, one discriminating test per gate:
 *  - the first sample seeds and cannot fire (warm-up)
 *  - a quiet camera + a loud spike → anomalous
 *  - the SAME absolute dBFS on a camera whose normal is that loud → NOT
 *  - a big relative jump that is still quiet → NOT (the absolute floor)
 *  - a jitter-free baseline cannot be tripped by a tiny nudge (MAD clamp)
 *  - the dB floor holds in the regime where the MAD test alone would pass —
 *    the ONLY case that distinguishes the two relative bars from each other
 *  - a jittery camera needs a bigger jump than a steady one for the same dB
 *  - silence never fires but still teaches the baseline
 *  - a long gap discards a baseline that no longer describes the camera
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_ANOMALY_MIN_SAMPLES,
  type AudioAnomalyConfig,
  emptyAudioBaseline,
  observeAudioAnomaly,
} from '../audio-anomaly-detector.js'

const CFG: AudioAnomalyConfig = {
  baselineMs: 60_000,
  silenceFloorDbfs: -55,
  minDbfs: -25,
  minDeviations: 4,
  minDeviationDb: 12,
}

/** Feed `n` frames of `dbfs` at 30 Hz starting at `startMs`. */
function warm(dbfs: number, n: number, startMs = 0, cfg: AudioAnomalyConfig = CFG) {
  let state = emptyAudioBaseline()
  let t = startMs
  for (let i = 0; i < n; i += 1) {
    state = observeAudioAnomaly(state, { timestampMs: t, dbfs }, cfg).nextState
    t += 33
  }
  return { state, nextMs: t }
}

describe('observeAudioAnomaly', () => {
  it('cannot fire on the first sample — it only seeds the baseline', () => {
    const res = observeAudioAnomaly(emptyAudioBaseline(), { timestampMs: 0, dbfs: -3 }, CFG)
    expect(res.verdict.kind).toBe('warmup')
    expect(res.nextState.count).toBe(1)
    expect(res.nextState.mean).toBe(-3)
  })

  it('stays in warm-up until one baseline time constant of history exists', () => {
    // Plenty of SAMPLES (30 Hz for 30 s = 900) but only half a time constant.
    const { state, nextMs } = warm(-50, 900)
    expect(state.count).toBeGreaterThan(AUDIO_ANOMALY_MIN_SAMPLES)
    expect(nextMs).toBeLessThan(CFG.baselineMs)
    const res = observeAudioAnomaly(state, { timestampMs: nextMs, dbfs: -5 }, CFG)
    expect(res.verdict.kind).toBe('warmup')
  })

  it('flags a loud spike on a quiet camera as anomalous', () => {
    const { state, nextMs } = warm(-50, 2400) // 30 Hz × ~79 s > baselineMs
    const res = observeAudioAnomaly(state, { timestampMs: nextMs, dbfs: -8 }, CFG)
    expect(res.verdict.kind).toBe('anomalous')
    if (res.verdict.kind !== 'anomalous') return
    expect(res.verdict.deviationDb).toBeGreaterThan(CFG.minDeviationDb)
    expect(res.verdict.dbfs).toBe(-8)
  })

  it('does NOT flag the same absolute level on a camera whose normal is that loud', () => {
    // Same -8 dBFS sample. This camera lives at -10 → it is ordinary here.
    const { state, nextMs } = warm(-10, 2400)
    const res = observeAudioAnomaly(state, { timestampMs: nextMs, dbfs: -8 }, CFG)
    expect(res.verdict.kind).toBe('not-anomalous')
  })

  it('does NOT flag a big relative jump that is still quiet in absolute terms', () => {
    // -52 → -30: +22 dB over its own normal, but below the high-volume floor.
    const { state, nextMs } = warm(-52, 2400)
    const res = observeAudioAnomaly(state, { timestampMs: nextMs, dbfs: -30 }, CFG)
    expect(res.verdict.kind).toBe('not-loud')
  })

  it('a jitter-free baseline is not trippable by a small nudge (MAD clamp)', () => {
    // mad → 0 would make every deviation infinite. The clamp is what stops a
    // 2 dB nudge on a dead-steady camera reading as infinitely surprising.
    const { state, nextMs } = warm(-20, 2400)
    expect(state.mad).toBeLessThan(0.5)
    const res = observeAudioAnomaly(state, { timestampMs: nextMs, dbfs: -18 }, CFG)
    expect(res.verdict.kind).toBe('not-anomalous')
  })

  it('the dB floor holds where the MAD test alone would already have passed', () => {
    // The regime the floor exists for: a mildly jittery camera (mad ≈ 2 dB).
    // A +9 dB jump is 4.5 MADs — past `minDeviations` — but 9 dB is not, by
    // any human account, an extraordinary jump. Without `minDeviationDb` this
    // fires, and a camera with a quiet-but-alive floor produces markers all
    // day. The MAD clamp cannot cover this: mad is 2, well above the clamp.
    let state = emptyAudioBaseline()
    let t = 0
    for (let i = 0; i < 2400; i += 1) {
      state = observeAudioAnomaly(
        state,
        { timestampMs: t, dbfs: i % 2 === 0 ? -31 : -35 },
        CFG,
      ).nextState
      t += 33
    }
    // Comfortably ABOVE the 1 dB clamp — so the clamp is provably not what
    // is deciding this case.
    expect(state.mad).toBeGreaterThan(1.2)
    expect(state.mad).toBeLessThan(3)
    const res = observeAudioAnomaly(state, { timestampMs: t, dbfs: -24 }, CFG)
    expect(res.verdict.kind).toBe('not-anomalous')
    if (res.verdict.kind !== 'not-anomalous') return
    expect(res.verdict.deviations).toBeGreaterThan(CFG.minDeviations)
    expect(res.verdict.deviationDb).toBeLessThan(CFG.minDeviationDb)
  })

  it('a jittery camera needs a BIGGER jump than a steady one for the same dB', () => {
    // Two cameras, same mean, different noise. +14 dB clears the dB floor on
    // both; only the steady one clears 4 MADs.
    let steady = emptyAudioBaseline()
    let jittery = emptyAudioBaseline()
    let t = 0
    for (let i = 0; i < 2400; i += 1) {
      steady = observeAudioAnomaly(steady, { timestampMs: t, dbfs: -40 }, CFG).nextState
      // ±6 dB swing around the same mean.
      const j = i % 2 === 0 ? -34 : -46
      jittery = observeAudioAnomaly(jittery, { timestampMs: t, dbfs: j }, CFG).nextState
      t += 33
    }
    expect(observeAudioAnomaly(steady, { timestampMs: t, dbfs: -24 }, CFG).verdict.kind).toBe(
      'anomalous',
    )
    expect(observeAudioAnomaly(jittery, { timestampMs: t, dbfs: -24 }, CFG).verdict.kind).toBe(
      'not-anomalous',
    )
  })

  it('never fires below the silence floor, but still learns from it', () => {
    const { state, nextMs } = warm(-70, 2400)
    const res = observeAudioAnomaly(state, { timestampMs: nextMs, dbfs: -80 }, CFG)
    expect(res.verdict.kind).toBe('silent')
    // The silent frame moved the mean — a quiet camera's normal IS quiet.
    expect(res.nextState.mean).toBeLessThan(-69)
    expect(res.nextState.count).toBe(state.count + 1)
  })

  it('discards a baseline older than the staleness bound instead of decaying it', () => {
    // An on-motion camera detaches for an hour. The stored mean describes a
    // scene that no longer exists; carrying it forward would make the first
    // frame back either a guaranteed marker or a guaranteed miss.
    const { state, nextMs } = warm(-50, 2400)
    const res = observeAudioAnomaly(state, { timestampMs: nextMs + 3_600_000, dbfs: -5 }, CFG)
    expect(res.verdict.kind).toBe('warmup')
    expect(res.nextState.count).toBe(1)
    expect(res.nextState.mean).toBe(-5)
  })
})
