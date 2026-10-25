/**
 * The audio lane of the timeline shows a LEVEL, and a level is not a count.
 *
 * ## What it showed instead
 *
 * The viewer's audio lane read `EventDensityBucket.audio` — the number of audio
 * EVENTS in the bucket — normalised it against a floor of 80 with `log1p`, and
 * painted the result on the same six-rung meter the live view uses for dBFS.
 * Measured:
 *
 * | events in the bucket | rungs lit |
 * | --- | --- |
 * | 5   | 2/5 |
 * | 20  | 4/5 |
 * | 50  | 5/5 — maximum |
 *
 * So fifty brief clicks in a quiet hour saturated the meter, whatever their
 * volume. That is the operator's report ("anche durante ore calme mostra il
 * massimo del livello" [even during quiet hours it shows the maximum level]), and it is a category error, not a scaling one: the bar
 * never looked at the level.
 *
 * A dBFS path existed in the viewer (`audioEventsToBuckets`) and took the
 * bucket's MAXIMUM — which the operator independently suspected was wrong — and
 * it had **zero callers**. It had sat there for months looking like the problem
 * was solved.
 *
 * ## Why the mean is energy-weighted
 *
 * dBFS is logarithmic, so an arithmetic mean of dB values is not the mean of
 * anything physical: it under-weights the loud moment that is the whole reason
 * a bar is worth looking at. Averaging POWER and converting back is the mean a
 * meter is expected to show — the same arithmetic as an RMS over the interval.
 *
 * A bucket with no audio events gets **no level at all**, not zero. Silence and
 * "nobody measured" are different claims, and -∞ dBFS is not a number a bar can
 * paint honestly.
 */
import { describe, expect, it } from 'vitest'
import { audioDbfsByBucket, energyWeightedMeanDbfs } from '../audio-level-density.js'

describe('energyWeightedMeanDbfs', () => {
  it('returns the value itself for a single sample', () => {
    expect(energyWeightedMeanDbfs([-30])).toBeCloseTo(-30, 6)
  })

  it('returns the common value when every sample agrees', () => {
    expect(energyWeightedMeanDbfs([-20, -20, -20])).toBeCloseTo(-20, 6)
  })

  it('sits ABOVE the arithmetic mean, because power dominates', () => {
    // -10 dB is 100x the power of -30 dB. The arithmetic mean is -20; the
    // energy mean is ~-13, which is what a meter shows.
    const samples = [-10, -30]
    const arithmetic = (-10 + -30) / 2
    const energy = energyWeightedMeanDbfs(samples)
    expect(energy).toBeGreaterThan(arithmetic)
    expect(energy).toBeCloseTo(-13.01, 1)
  })

  it('is bounded by the loudest sample — a mean can never exceed the max', () => {
    const samples = [-40, -12, -35, -50]
    expect(energyWeightedMeanDbfs(samples)).toBeLessThanOrEqual(-12)
  })

  it('is NOT the max — that is the thing being replaced', () => {
    const samples = [-60, -60, -60, -12]
    expect(energyWeightedMeanDbfs(samples)).toBeLessThan(-12)
  })

  it('has no value for no samples', () => {
    expect(energyWeightedMeanDbfs([])).toBeUndefined()
  })

  it('counts digital silence as a real sample of zero power, and NaN as none', () => {
    // -Infinity is a MEASUREMENT — of silence — so it belongs in the mean and
    // pulls it down: one sample at -20 dB beside one silent sample is half the
    // power, i.e. -23 dB. What it must not do is make the whole bucket
    // -Infinity, which is what a naive `Math.min`/log would produce.
    expect(energyWeightedMeanDbfs([-20, Number.NEGATIVE_INFINITY])).toBeCloseTo(-23.01, 1)
    // NaN carries no claim at all: it is dropped, and a bucket of nothing but
    // NaN has no level rather than a made-up one.
    expect(energyWeightedMeanDbfs([Number.NaN])).toBeUndefined()
    expect(energyWeightedMeanDbfs([-20, Number.NaN])).toBeCloseTo(-20, 6)
  })
})

describe('audioDbfsByBucket', () => {
  const SINCE = 1_000_000
  const BUCKET = 10_000

  it('bins each event into the bucket its timestamp falls in', () => {
    const got = audioDbfsByBucket(
      [
        { timestamp: SINCE + 1, dbfs: -20 },
        { timestamp: SINCE + BUCKET + 1, dbfs: -40 },
      ],
      SINCE,
      BUCKET,
    )
    expect(got.get(0)).toBeCloseTo(-20, 6)
    expect(got.get(1)).toBeCloseTo(-40, 6)
  })

  it('leaves a bucket with no events ABSENT, never zero', () => {
    const got = audioDbfsByBucket([{ timestamp: SINCE + 1, dbfs: -20 }], SINCE, BUCKET)
    expect(got.has(1)).toBe(false)
  })

  it('drops an event before the window instead of folding it into bucket 0', () => {
    const got = audioDbfsByBucket([{ timestamp: SINCE - 5_000, dbfs: -3 }], SINCE, BUCKET)
    expect(got.size).toBe(0)
  })

  it('averages the events that share a bucket', () => {
    const got = audioDbfsByBucket(
      [
        { timestamp: SINCE + 1, dbfs: -10 },
        { timestamp: SINCE + 2, dbfs: -30 },
      ],
      SINCE,
      BUCKET,
    )
    expect(got.get(0)).toBeCloseTo(-13.01, 1)
  })

  it('survives a bucket width of zero without looping forever', () => {
    expect(audioDbfsByBucket([{ timestamp: SINCE, dbfs: -20 }], SINCE, 0).size).toBe(0)
  })
})
