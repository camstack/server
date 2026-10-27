import { describe, expect, it } from 'vitest'
import type { DeviceHistoryQueryResult, DeviceHistorySeriesInfo } from '@camstack/types'
import {
  chartKeys,
  energyBuckets,
  filterOccupancyLines,
  groupDeviceSeries,
  linePoints,
  occupancyFacets,
  occupancyLines,
  stateRow,
} from '../history-model'

const info = (
  key: string,
  over: Partial<DeviceHistorySeriesInfo> = {},
): DeviceHistorySeriesInfo => ({
  key,
  scope: '',
  kind: 'gauge',
  unit: null,
  displayName: key,
  source: key.startsWith('addon:') ? 'addon' : key.startsWith('derived:') ? 'derived' : 'cap',
  values: null,
  firstTs: 0,
  lastTs: 0,
  ...over,
})

const H = 3_600_000

describe('groupDeviceSeries — scope grouping', () => {
  const series = [
    info('cap:power-meter.power', { unit: 'W' }),
    info('cap:climate-control.currentHumidity', { unit: '%' }),
    info('cap:climate-control.currentTemp', { unit: '°C' }),
    info('cap:climate-control.target', { unit: '°C' }),
    info('cap:contact.entryOpen', { kind: 'boolean' }),
    info('derived:energy.kwh', { kind: 'counter', unit: 'kWh', source: 'derived' }),
    info('addon:pipeline-analytics/occupancy', { scope: 'porch|person' }),
    info('addon:pipeline-analytics/occupancy', { scope: '' }),
    info('addon:pipeline-analytics/motion'),
  ]
  const sections = groupDeviceSeries(series, (c) => c)

  it('orders capability sections as the catalog does, producers after them', () => {
    expect(sections.map((s) => s.id)).toEqual([
      'cap:climate-control',
      'cap:contact',
      'cap:power-meter',
      'addon:pipeline-analytics',
    ])
  })

  it('draws one line chart per UNIT, fields in catalog order — never two units on one axis', () => {
    const climate = sections.find((s) => s.id === 'cap:climate-control')
    const lines = climate?.charts.filter((c) => c.type === 'lines') ?? []
    expect(lines.map((c) => (c.type === 'lines' ? c.unit : null))).toEqual(['°C', '%'])
    const celsius = lines[0]
    expect(celsius?.type === 'lines' ? celsius.series.map((s) => s.key) : []).toEqual([
      'cap:climate-control.currentTemp',
      'cap:climate-control.target',
    ])
  })

  it('gives each boolean its own timeline and puts energy beside the power meter', () => {
    expect(sections.find((s) => s.id === 'cap:contact')?.charts.map((c) => c.type)).toEqual([
      'states',
    ])
    expect(sections.find((s) => s.id === 'cap:power-meter')?.charts.map((c) => c.type)).toEqual([
      'lines',
      'energy',
    ])
  })

  it('makes ONE occupancy chart of every scope, first in its section', () => {
    const analytics = sections.find((s) => s.id === 'addon:pipeline-analytics')
    expect(analytics?.charts[0]?.type).toBe('occupancy')
    const occ = analytics?.charts[0]
    expect(occ?.type === 'occupancy' ? occ.series.map((s) => s.scope) : []).toEqual([
      '',
      'porch|person',
    ])
  })

  it('reads each key once, every scope included', () => {
    const keys = chartKeys(sections.flatMap((s) => s.charts))
    expect(keys.filter((k) => k === 'addon:pipeline-analytics/occupancy')).toHaveLength(1)
  })

  it('puts energy in its own section on a device without a power meter', () => {
    const only = groupDeviceSeries([info('derived:energy.kwh', { unit: 'kWh' })], (c) => c)
    expect(only.map((s) => s.id)).toEqual(['cap:energy'])
  })
})

const result = (
  resolution: DeviceHistoryQueryResult['resolution'],
  points: Partial<DeviceHistoryQueryResult['series'][number]['points'][number]>[],
  before: DeviceHistoryQueryResult['series'][number]['before'] = null,
  scope = '',
): DeviceHistoryQueryResult => ({
  resolution,
  truncated: false,
  series: [
    {
      scope,
      before,
      derivedFrom: null,
      points: points.map((p) => ({
        t: 0,
        samples: 1,
        mean: null,
        twMean: null,
        min: 0,
        max: 0,
        last: null,
        delta: null,
        state: null,
        states: null,
        ...p,
      })),
    },
  ],
})

describe('linePoints', () => {
  it('opens a held cap series on the value in force before the window', () => {
    const r = result('raw', [{ t: 5 * H, last: 21 }], { t: -H, value: 19, state: null })
    const out = linePoints(info('cap:x.y'), r, 0)
    expect(out.points.map((p) => [p.t, p.v])).toEqual([
      [0, 19],
      [5 * H, 21],
    ])
    expect(out.held).toBe(true)
    expect(out.gapMs).toBeUndefined()
  })

  it('treats a producer bucket series as unheld, with a gap of 2.5 buckets', () => {
    const r = result('5m', [{ t: 0, mean: 2 }])
    const out = linePoints(info('addon:a/b'), r, 0)
    expect(out.gapMs).toBe(2.5 * 5 * 60_000)
    expect(out.points[0]?.v).toBe(2)
  })

  it('prefers the time-weighted mean and carries the bucket spread as a band', () => {
    const r = result('1h', [{ t: 0, twMean: 20.5, mean: 30, min: 19, max: 22 }])
    expect(linePoints(info('cap:x.y'), r, 0).points[0]).toEqual({ t: 0, v: 20.5, min: 19, max: 22 })
  })

  it('answers no point (never a zero) when the read has nothing', () => {
    expect(linePoints(info('cap:x.y'), undefined, 0).points).toEqual([])
  })
})

describe('stateRow — enum durations', () => {
  it('sums the exact milliseconds per state from rollups, drawn in the dominant state', () => {
    const r = result('1h', [
      { t: 0, state: 'running', states: { idle: 0.25 * H, running: 0.75 * H } },
      { t: H, state: 'idle', states: { idle: H } },
    ])
    const row = stateRow(
      info('cap:dishwasher.state', { kind: 'enum', values: ['idle', 'running'] }),
      r,
      0,
      2 * H,
    )
    expect(row.totals.get('idle')).toBe(1.25 * H)
    expect(row.totals.get('running')).toBe(0.75 * H)
    expect(row.segments.map((s) => s.state)).toEqual(['running', 'idle'])
  })

  it('turns raw boolean points into changes, starting at the held state', () => {
    const r = result('raw', [{ t: H, last: 0 }], { t: -1, value: 1, state: null })
    const row = stateRow(info('cap:contact.entryOpen', { kind: 'boolean' }), r, 0, 3 * H)
    expect(row.states).toEqual(['false', 'true'])
    expect(row.totals.get('true')).toBe(H)
    expect(row.totals.get('false')).toBe(2 * H)
  })

  it('splits a boolean rollup by its time-weighted fraction', () => {
    const r = result('1h', [{ t: 0, twMean: 0.25 }])
    const row = stateRow(info('cap:switch.on', { kind: 'boolean' }), r, 0, H)
    expect(row.totals.get('true')).toBe(0.25 * H)
  })
})

describe('energyBuckets', () => {
  it('uses the delta per bucket and keeps an unknown bucket unknown', () => {
    const r = result('1h', [
      { t: 0, delta: 0.4 },
      { t: H, delta: null },
    ])
    expect(energyBuckets(r)).toEqual({
      bucketMs: H,
      buckets: [
        { t: 0, values: [0.4] },
        { t: H, values: [null] },
      ],
    })
  })
})

describe('occupancy zone × class', () => {
  const lines = occupancyLines(
    ['', '|person', 'drive', 'drive|person', 'drive|car'].map((scope) =>
      info('addon:pipeline-analytics/occupancy', { scope }),
    ),
  )

  it('offers the zones and classes that exist', () => {
    expect(occupancyFacets(lines)).toEqual({ zones: ['', 'drive'], classes: ['car', 'person'] })
  })

  it('shows the per-zone aggregates with no class picked (never a double count)', () => {
    expect(
      filterOccupancyLines(lines, { zone: null, className: null }).map((l) => l.scope),
    ).toEqual(['', 'drive'])
  })

  it('narrows to a class in every zone, or one zone', () => {
    expect(
      filterOccupancyLines(lines, { zone: null, className: 'person' }).map((l) => l.scope),
    ).toEqual(['|person', 'drive|person'])
    expect(
      filterOccupancyLines(lines, { zone: 'drive', className: 'car' }).map((l) => l.scope),
    ).toEqual(['drive|car'])
  })
})
