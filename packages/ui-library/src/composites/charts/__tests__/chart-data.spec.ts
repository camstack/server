import { describe, expect, it } from 'vitest'
import {
  alignSeries,
  formatSpan,
  segmentsFromChanges,
  sharedGapSpans,
  stackSeries,
  stateAt,
  timeInState,
  valueAtOrBefore,
} from '../chart-data'
import { bucketTotals, stackBuckets } from '../bar-series-model'
import { buildTimeSeriesModel, readoutAt, unitAxes } from '../time-series-model'

describe('alignSeries', () => {
  it('joins two cadences without breaking either line (fillers are undefined, not null)', () => {
    const a = { points: [0, 10, 20].map((t) => ({ t, v: 1 })), gapMs: 25 }
    const b = { points: [5, 15].map((t) => ({ t, v: 2 })), gapMs: 25 }
    const out = alignSeries([a, b])
    expect(out.xs).toEqual([0, 5, 10, 15, 20])
    expect(out.ys[0]).toEqual([1, undefined, 1, undefined, 1])
    expect(out.ys[1]).toEqual([undefined, 2, undefined, 2, undefined])
  })

  it('BREAKS a line across a hole longer than gapMs, even between two known values', () => {
    const out = alignSeries([
      {
        points: [
          { t: 0, v: 1 },
          { t: 100, v: 1 },
        ],
        gapMs: 30,
      },
    ])
    expect(out.xs).toEqual([0, 1, 100])
    expect(out.ys[0]).toEqual([1, null, 1])
  })

  it('breaks the min/max band at a hole too — a band never spans what nobody measured', () => {
    const out = alignSeries([
      {
        points: [
          { t: 0, v: 1, min: 0, max: 2 },
          { t: 100, v: 1, min: 0, max: 2 },
        ],
        gapMs: 30,
      },
    ])
    expect(out.mins[0]).toEqual([0, null, 0])
    expect(out.maxs[0]).toEqual([2, null, 2])
  })

  it('never breaks a held (change-only) series, which has no gapMs', () => {
    const out = alignSeries([
      {
        points: [
          { t: 0, v: 1 },
          { t: 10_000_000, v: 2 },
        ],
      },
    ])
    expect(out.ys[0]).toEqual([1, 2])
  })

  it('keeps an unknown sample unknown — null, never zero', () => {
    const out = alignSeries([{ points: [{ t: 0, v: null }] }])
    expect(out.ys[0]).toEqual([null])
  })
})

describe('sharedGapSpans', () => {
  it('shades only what NOBODY measured', () => {
    const a = {
      points: [
        { t: 0, v: 1 },
        { t: 100, v: 1 },
      ],
      gapMs: 30,
    }
    const b = { points: [0, 25, 50, 100].map((t) => ({ t, v: 1 })), gapMs: 30 }
    expect(sharedGapSpans([a, b])).toEqual([{ from: 50, to: 100 }])
  })

  it('shades nothing when one series is held (no gapMs)', () => {
    const a = {
      points: [
        { t: 0, v: 1 },
        { t: 100, v: 1 },
      ],
      gapMs: 30,
    }
    const b = {
      points: [
        { t: 0, v: 1 },
        { t: 100, v: 1 },
      ],
    }
    expect(sharedGapSpans([a, b])).toEqual([])
  })
})

describe('stackSeries', () => {
  it('sums the layers, and a level is unknown when a layer under it is', () => {
    expect(
      stackSeries([
        [1, null, 2],
        [3, 4, undefined],
      ]),
    ).toEqual([
      [1, null, 2],
      [4, null, undefined],
    ])
  })
})

describe('time series model', () => {
  it('gives one axis per unit, in order of first appearance', () => {
    const s = (id: string, unit: string | null) => ({
      id,
      label: id,
      unit,
      colorIndex: 0,
      points: [],
    })
    expect(unitAxes([s('a', '°C'), s('b', '%'), s('c', '°C'), s('d', null)])).toEqual([
      '°C',
      '%',
      '',
    ])
  })

  it('stacks the primary series only — a compare overlay keeps its raw values', () => {
    const pts = [{ t: 0, v: 2 }]
    const model = buildTimeSeriesModel(
      [
        { id: 'a', label: 'a', colorIndex: 0, points: pts },
        { id: 'b', label: 'b', colorIndex: 1, points: pts },
        { id: 'c', label: 'c', colorIndex: 0, points: pts, compare: true },
      ],
      true,
    )
    expect(model.drawn.map((r) => r[0])).toEqual([2, 4, 2])
    // The readout says what each series measured, not the stack height.
    expect(readoutAt(model, 0)).toEqual([2, 2, 2])
  })

  it('is empty when no series has a known value', () => {
    const model = buildTimeSeriesModel(
      [{ id: 'a', label: 'a', colorIndex: 0, points: [{ t: 0, v: null }] }],
      false,
    )
    expect(model.empty).toBe(true)
  })

  it('reads the held value through an alignment filler', () => {
    expect(valueAtOrBefore([0, 5, 10], [1, undefined, undefined], 2)).toBe(1)
    expect(valueAtOrBefore([0, 5], [1, null], 1)).toBeNull()
  })
})

describe('states', () => {
  const H = 3_600_000

  it('turns changes into segments clipped to the window, starting at the held state', () => {
    const segs = segmentsFromChanges(
      [
        { t: 2 * H, state: 'open' },
        { t: 3 * H, state: 'closed' },
      ],
      0,
      4 * H,
      'closed',
    )
    expect(segs).toEqual([
      { from: 0, to: 2 * H, state: 'closed' },
      { from: 2 * H, to: 3 * H, state: 'open' },
      { from: 3 * H, to: 4 * H, state: 'closed' },
    ])
    expect(stateAt(segs, 2.5 * H)).toBe('open')
  })

  it('leaves the start UNKNOWN without a held state — unknown is not a state', () => {
    const segs = segmentsFromChanges([{ t: H, state: 'on' }], 0, 2 * H)
    expect(segs).toEqual([{ from: H, to: 2 * H, state: 'on' }])
    expect(stateAt(segs, 0.5 * H)).toBeNull()
  })

  it('sums the time spent in each state ("open 2h 14m")', () => {
    const segs = [
      { from: 0, to: 2 * H + 14 * 60_000, state: 'open' },
      { from: 2 * H + 14 * 60_000, to: 5 * H, state: 'closed' },
      { from: 5 * H, to: 6 * H, state: 'open' },
    ]
    const totals = timeInState(segs)
    expect(formatSpan(totals.get('open') ?? 0)).toBe('3h 14m')
    expect(formatSpan(totals.get('closed') ?? 0)).toBe('2h 46m')
  })

  it('formats spans with at most two units', () => {
    expect(formatSpan(45_000)).toBe('45s')
    expect(formatSpan(3 * 86_400_000 + 4 * H)).toBe('3d 4h')
    expect(formatSpan(0)).toBe('0s')
  })
})

describe('bars', () => {
  it('stacks layers and totals the window; an unanswered bucket adds nothing', () => {
    const buckets = [
      { t: 0, values: [1, 2] },
      { t: 1, values: [null, 3] },
    ]
    expect(stackBuckets(buckets, 2)).toEqual([
      [1, null],
      [3, 3],
    ])
    expect(bucketTotals(buckets, 2)).toEqual({ perLayer: [1, 5], total: 6, known: true })
    expect(bucketTotals([{ t: 0, values: [null] }], 1).known).toBe(false)
  })
})
