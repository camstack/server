import { describe, expect, it } from 'vitest'
import {
  GAP_HISTOGRAM_LENGTHS,
  INITIAL_LATENCY_TALLY,
  INITIAL_PRESENCE_TALLY,
  recordLatency,
  recordPresence,
  summarize,
} from '../frame-measurements.js'

describe('recordLatency', () => {
  it('keeps count, sum, min and max', () => {
    const t = [120, 40, 800].reduce(recordLatency, INITIAL_LATENCY_TALLY)
    expect(t.frames).toBe(3)
    expect(t.minMs).toBe(40)
    expect(t.maxMs).toBe(800)
    expect(summarize(t, INITIAL_PRESENCE_TALLY).latencyMeanMs).toBeCloseTo(320)
  })

  it('bins into the bucket whose upper bound it first fits', () => {
    const t = recordLatency(INITIAL_LATENCY_TALLY, 100)
    // bounds are [50, 100, 200, ...]; 100 <= 100 lands in bucket index 1.
    expect(t.bucketCounts[1]).toBe(1)
    expect(t.bucketCounts[0]).toBe(0)
  })

  it('puts anything above the last bound in the overflow slot', () => {
    const t = recordLatency(INITIAL_LATENCY_TALLY, 60_000)
    expect(t.bucketCounts[t.bucketBoundsMs.length]).toBe(1)
  })

  it('counts a negative age separately instead of hiding it in the mean', () => {
    const t = recordLatency(INITIAL_LATENCY_TALLY, -120)
    expect(t.negativeAgeFrames).toBe(1)
    expect(t.minMs).toBe(-120)
  })

  it('reports an unmeasured mean as null, not zero', () => {
    expect(summarize(INITIAL_LATENCY_TALLY, INITIAL_PRESENCE_TALLY).latencyMeanMs).toBeNull()
  })
})

describe('recordPresence', () => {
  it('counts every frame a target was held, and the absent ones among them', () => {
    const t = [true, false, true, true].reduce(recordPresence, INITIAL_PRESENCE_TALLY)
    expect(t.framesWithTarget).toBe(4)
    expect(t.absentFrames).toBe(1)
    expect(summarize(INITIAL_LATENCY_TALLY, t).absentFraction).toBeCloseTo(0.25)
  })

  it('bins a gap by its LENGTH, when it closes — that shape is the premise test', () => {
    const t = [true, false, true, false, false, false, true].reduce(
      recordPresence,
      INITIAL_PRESENCE_TALLY,
    )
    expect(t.gapRunHistogram[0]).toBe(1) // one gap of length 1
    expect(t.gapRunHistogram[2]).toBe(1) // one gap of length 3
    expect(t.maxGapFrames).toBe(3)
    expect(t.currentGapFrames).toBe(0)
  })

  it('reports an OPEN gap separately so it is not counted twice', () => {
    const t = [true, false, false].reduce(recordPresence, INITIAL_PRESENCE_TALLY)
    expect(t.currentGapFrames).toBe(2)
    expect(t.gapRunHistogram.every((n) => n === 0)).toBe(true)
  })

  it('overflows a very long gap into the final slot', () => {
    const frames = [true, ...Array.from({ length: GAP_HISTOGRAM_LENGTHS + 3 }, () => false), true]
    const t = frames.reduce(recordPresence, INITIAL_PRESENCE_TALLY)
    expect(t.gapRunHistogram[GAP_HISTOGRAM_LENGTHS]).toBe(1)
  })

  it('reports an absent fraction over zero frames as null, not zero (D393)', () => {
    expect(summarize(INITIAL_LATENCY_TALLY, INITIAL_PRESENCE_TALLY).absentFraction).toBeNull()
  })

  it('never mutates the tally it was given', () => {
    const before = INITIAL_PRESENCE_TALLY
    const snapshot = JSON.stringify(before)
    recordPresence(before, false)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
