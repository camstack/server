/**
 * The ONE reader over both tiers — and the reduction, which is the point at
 * which a chart lies.
 *
 * Two claims are load-bearing here and neither is about a total:
 *
 * 1. **A point present in both tiers is drawn once.** A doubled point is
 *    invisible in a sum and shows up only as a chart that reads twice as loud
 *    as the machine.
 * 2. **A peak survives the reduction.** Six hours at the 10 s cadence is 2 160
 *    points and a chart has to reduce them. A mean per bucket smears a spike
 *    away; every-Nth skips it. Either gives us a tool built to find peaks that
 *    does not show peaks — the graphical version of a number that looks true.
 */
import { describe, expect, it } from 'vitest'
import { mergeLoadSeries, mergeSamples } from '../load-series-reader.js'
import type { RetainedProcess, RetainedSample } from '../load-series-types.js'

function process(over: Partial<RetainedProcess> & { pid: number }): RetainedProcess {
  return {
    addonId: 'recorder',
    classification: 'managed',
    cpuPercent: 1,
    memoryRssBytes: 1_048_576,
    cpuMainPercent: 1,
    cpuGcPercent: 0,
    ...over,
  }
}

function sample(atMs: number, cpuMain: number): RetainedSample {
  return { atMs, processes: [process({ pid: 1, cpuMainPercent: cpuMain })] }
}

const CADENCE_MS = 10_000

describe('hot + cold merge — one point, whatever the tier', () => {
  it('does not double a sample the two tiers both hold', () => {
    const overlapping = [sample(1_000, 5), sample(2_000, 5)]
    const merged = mergeSamples(overlapping, overlapping)
    expect(merged.map((s) => s.atMs)).toEqual([1_000, 2_000])
  })

  it('returns the union, oldest-first, whatever order the tiers arrive in', () => {
    const merged = mergeSamples(
      [sample(3_000, 1), sample(1_000, 1)],
      [sample(2_000, 1), sample(4_000, 1)],
    )
    expect(merged.map((s) => s.atMs)).toEqual([1_000, 2_000, 3_000, 4_000])
  })

  it('lets the HOT copy win a tie — it is the payload as it arrived', () => {
    const merged = mergeSamples([sample(1_000, 5)], [sample(1_000, 9)])
    expect(merged[0]?.processes[0]?.cpuMainPercent).toBe(9)
  })

  it('draws an overlapping window exactly once, end to end', () => {
    const cold = [sample(1_000, 4), sample(2_000, 4), sample(3_000, 4)]
    const hot = [sample(3_000, 4), sample(4_000, 4)]
    const out = mergeLoadSeries({ cold, hot, cadenceMs: CADENCE_MS })
    expect(out.retainedSamples).toBe(4)
    expect(out.series[0]?.points.map((p) => p.atMs)).toEqual([1_000, 2_000, 3_000, 4_000])
  })

  it('answers an empty series rather than an error when neither tier has anything', () => {
    const out = mergeLoadSeries({ cold: [], hot: [], cadenceMs: CADENCE_MS })
    expect(out.series).toEqual([])
    expect(out.oldestAtMs).toBeNull()
    expect(out.bucketMs).toBe(CADENCE_MS)
  })
})

describe('the reduction PRESERVES the peak — the whole point of the tool', () => {
  it('keeps a single spike inside a window of quiet samples', () => {
    // 100 samples at 2 %, with ONE at 400 % buried at index 57. Reduced to 5
    // buckets, so ~20 samples share the spike's bucket. A mean would report
    // ~21.9 % there; every-Nth would land on index 0/20/40/60/80 and miss 57
    // outright. Both are the failure this asserts against.
    const samples: RetainedSample[] = []
    for (let i = 0; i < 100; i++) {
      samples.push(sample(1_000 + i * CADENCE_MS, i === 57 ? 400 : 2))
    }

    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 5 })
    const points = out.series[0]?.points ?? []

    expect(points.length).toBeLessThanOrEqual(5)
    // THE assertion: the spike is still there, at full height, in SOME bucket.
    const peak = Math.max(...points.map((p) => p.cpuMainPercent ?? 0))
    expect(peak).toBe(400)

    // And it is the bucket that actually contains it, with its floor intact —
    // a bucket that reported only the peak would be a different lie.
    const spikeBucket = points.find((p) => p.cpuMainPercent === 400)
    expect(spikeBucket?.cpuMainPercentMin).toBe(2)
    expect(spikeBucket?.samples).toBeGreaterThan(1)

    // A mean would have been ~21.9. Pinned so that swapping max for an average
    // fails loudly rather than drifting.
    expect(peak).not.toBeCloseTo(21.9, 1)
  })

  it('preserves the peak of memory too, not only of CPU', () => {
    const samples: RetainedSample[] = []
    for (let i = 0; i < 60; i++) {
      samples.push({
        atMs: 1_000 + i * CADENCE_MS,
        processes: [process({ pid: 1, memoryRssBytes: i === 31 ? 11_400_000_000 : 500_000_000 })],
      })
    }
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 4 })
    const points = out.series[0]?.points ?? []
    expect(Math.max(...points.map((p) => p.memoryRssBytes))).toBe(11_400_000_000)
  })

  it('counts every raw sample it folded, so a bucket can be weighed', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(1_000 + i * CADENCE_MS, 3))
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 4 })
    const total = (out.series[0]?.points ?? []).reduce((sum, p) => sum + p.samples, 0)
    expect(total).toBe(20)
  })

  it('keeps a one-tick spike across the REAL window: six hours at 10 s, 720 points', () => {
    // The shipped configuration, not a miniature of it. Six hours at the 10 s
    // cadence is 2 160 snapshots per series and the admin UI asks for 720
    // (`DEFAULT_MAX_POINTS`), so every point on the drawn chart covers three
    // raw samples. A single 692 % tick — the number that started the whole
    // load investigation — lasts ONE sample out of 2 160.
    //
    // A mean over its bucket would report ~232 %, a third of the truth; every
    // 3rd sample would miss it two times out of three. Both hide the one event
    // the operator opened this chart to find, on a chart that otherwise looks
    // completely normal.
    const SAMPLES = 2_160
    const SPIKE_AT = 1_493
    const samples: RetainedSample[] = []
    for (let i = 0; i < SAMPLES; i++) {
      samples.push(sample(1_000 + i * CADENCE_MS, i === SPIKE_AT ? 692 : 8))
    }

    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 720 })
    const points = out.series[0]?.points ?? []

    expect(points.length).toBeLessThanOrEqual(720)
    expect(out.bucketMs).toBe(CADENCE_MS * 3)
    // The spike is on the chart, at full height.
    expect(Math.max(...points.map((p) => p.cpuMainPercent ?? 0))).toBe(692)
    // In its OWN bucket, with the quiet floor beside it — a bucket reporting
    // only the peak would be a different lie.
    const spikeBucket = points.find((p) => p.cpuMainPercent === 692)
    expect(spikeBucket?.cpuMainPercentMin).toBe(8)
    expect(spikeBucket?.samples).toBe(3)
    // Exactly ONE bucket carries it: the peak is not smeared across neighbours.
    expect(points.filter((p) => p.cpuMainPercent === 692)).toHaveLength(1)
    // Pinned against the two reductions that would lose it.
    const mean = (692 + 8 + 8) / 3
    expect(spikeBucket?.cpuMainPercent).not.toBeCloseTo(mean, 1)
    expect(points.every((p) => p.cpuMainPercent === 8)).toBe(false)
    // And nothing was invented: every raw sample is accounted for.
    expect(points.reduce((sum, p) => sum + p.samples, 0)).toBe(SAMPLES)
  })

  it('does not reduce at all when the window already fits', () => {
    const samples = [sample(1_000, 1), sample(11_000, 2), sample(21_000, 3)]
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 100 })
    expect(out.bucketMs).toBe(CADENCE_MS)
    const points = out.series[0]?.points ?? []
    expect(points.map((p) => p.atMs)).toEqual([1_000, 11_000, 21_000])
    // An unreduced point is a one-sample bucket: min === max.
    expect(points.every((p) => p.samples === 1)).toBe(true)
    expect(points.every((p) => p.cpuMainPercent === p.cpuMainPercentMin)).toBe(true)
  })
})

describe('a gap stays a gap', () => {
  it('emits NO bucket for an interval nobody reported', () => {
    // Samples on either side of a 10-bucket hole. Emission is fixed-cadence,
    // so the hole means one thing: nobody reported. Filling it — with a zero,
    // with an interpolation, or by carrying the previous value forward —
    // destroys the only property fixed cadence was adopted to buy.
    const samples = [
      sample(0, 5),
      sample(CADENCE_MS, 5),
      sample(CADENCE_MS * 40, 5),
      sample(CADENCE_MS * 41, 5),
    ]
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 20 })
    const points = out.series[0]?.points ?? []

    // Two clusters, and NOTHING in between: the number of points is the number
    // of buckets that actually had samples, never the span divided by width.
    expect(points.length).toBeLessThanOrEqual(4)
    const spanBuckets = (CADENCE_MS * 41) / out.bucketMs
    expect(points.length).toBeLessThan(spanBuckets)
    expect(points.every((p) => p.samples > 0)).toBe(true)
  })

  it('never reports a zero-sample bucket', () => {
    const samples = [sample(0, 1), sample(CADENCE_MS * 100, 1)]
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 10 })
    for (const fn of out.series) {
      expect(fn.points.every((p) => p.samples >= 1)).toBe(true)
    }
  })
})

describe('UNKNOWN propagates through the reduction', () => {
  it('a bucket containing one unknown split reports null, not a partial max', () => {
    const samples: RetainedSample[] = [
      { atMs: 0, processes: [process({ pid: 1, cpuMainPercent: 50, cpuGcPercent: 10 })] },
      {
        atMs: CADENCE_MS,
        processes: [process({ pid: 1, cpuMainPercent: null, cpuGcPercent: null })],
      },
    ]
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS, maxPoints: 1 })
    const point = out.series[0]?.points[0]
    expect(point?.cpuMainPercent).toBeNull()
    // The lifetime average is always known, so it survives — the UI falls back
    // to it and says which one it is showing.
    expect(point?.cpuLifetimePercent).toBe(1)
  })
})

describe('functions are separated and ordered', () => {
  it('folds each addon into its own series and puts the heaviest first', () => {
    const samples: RetainedSample[] = [
      {
        atMs: 0,
        processes: [
          process({ pid: 1, addonId: 'quiet', cpuMainPercent: 1, cpuGcPercent: 0 }),
          process({ pid: 2, addonId: 'busy', cpuMainPercent: 50, cpuGcPercent: 138 }),
        ],
      },
    ]
    const out = mergeLoadSeries({ cold: samples, hot: [], cadenceMs: CADENCE_MS })
    expect(out.series.map((s) => s.key)).toEqual(['busy', 'quiet'])
  })
})
