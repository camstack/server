// @vitest-environment jsdom
/**
 * A composed sensor: every reading carries the single-reading card's own motion and
 * trend, and a click on a reading opens that reading's history chart under the card
 * (one at a time, a second click closes it).
 */
import type { HeroMeasurement } from '@dominevo/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { MeasuredPieCard } from '../connected/MeasuredPieCard'

const common = plugFixtures(0)[0]?.model.common
if (common === undefined) throw new Error('no plug fixture')

vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => ({ common, actions: undefined }),
}))
vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerGetDevice: () => ({ data: undefined, isPending: false }),
}))
vi.mock('../connected/SensorTrend', () => ({
  SensorTrend: (p: { historyKey: string; compact?: boolean }) => (
    <span data-testid="dc-sensor-trend" data-key={p.historyKey} data-compact={String(p.compact)} />
  ),
}))
// A state reading is the library's one state band: expose what it was given.
vi.mock('../../charts/StateTimeline', () => ({
  StateTimeline: (p: {
    title: string
    hideTitle?: boolean
    rows: readonly { id: string; colorIndex?: number }[]
  }) => (
    <span
      data-testid="state-chart"
      data-keys={p.rows.map((r) => r.id).join(',')}
      data-slots={p.rows.map((r) => String(r.colorIndex)).join(',')}
      data-hide-title={String(p.hideTitle === true)}
    />
  ),
}))
// The history reads: every series this fixture names exists and answers nothing but a line.
vi.mock('../../device-history/use-device-history', () => ({
  anchorNow: (now: number) => now,
  readItemId: (i: { deviceId: number; key: string }) => `${String(i.deviceId)}|${i.key}`,
  useDeviceSeriesList: () => ({
    presence: 'present',
    list: {
      status: 'ok',
      data: [
        { key: 'cap:motion.detected', scope: '', kind: 'boolean', source: 'cap', unit: null },
        ...['temperature', 'humidity'].map((q) => ({
          key: `cap:${q}.value`,
          scope: '',
          kind: 'gauge',
          source: 'cap',
          unit: q === 'temperature' ? '°C' : '%',
        })),
      ],
    },
  }),
  useHistoryReads: () => ({
    status: 'ok',
    data: { current: new Map(), previous: null, shiftMs: 0 },
  }),
}))
// The chart is the energy card's `TimeSeriesChart`: expose what it was given.
vi.mock('../../charts/TimeSeriesChart', () => ({
  TimeSeriesChart: (p: {
    title: string
    hideTitle?: boolean
    series: readonly { id: string; unit?: string | null; colorIndex: number }[]
  }) => (
    <span
      data-testid="history-chart"
      data-keys={p.series.map((s) => s.id).join(',')}
      data-units={p.series.map((s) => String(s.unit)).join(',')}
      data-slots={p.series.map((s) => String(s.colorIndex)).join(',')}
      data-hide-title={String(p.hideTitle === true)}
    />
  ),
}))

afterEach(cleanup)

/** The i-th of a rendered list; a missing one fails the test by name, no cast. */
function nth<T>(list: readonly T[], i: number): T {
  const item = list[i]
  if (item === undefined) throw new Error(`no element ${String(i)} of ${String(list.length)}`)
  return item
}

const measurement = (
  quantity: HeroMeasurement['quantity'],
  over: Partial<HeroMeasurement>,
): HeroMeasurement =>
  ({
    quantity,
    icon: 'thermometer',
    value: { en: '30', it: '30' },
    unit: null,
    band: 'hot',
    level: 1,
    tone: 'warning',
    word: { en: 'Hot', it: 'Caldo' },
    since: null,
    reading: { quantity: 'temperature', value: 30 },
    historyKey: `cap:${quantity}.value`,
    ...over,
  }) as unknown as HeroMeasurement

const shown = [
  measurement('temperature', {}),
  measurement('humidity', { band: null, level: null }),
  measurement('co2', {
    band: null,
    level: null,
    historyKey: null,
    reading: null,
  }),
]

describe('MeasuredPieCard in the grid', () => {
  const draw = (): void => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} grid showName />)
  }

  it('each tile carries its own motion and trend, like the single-reading card', () => {
    draw()
    const tiles = screen.getAllByTestId('dc-grid-tile')
    expect(
      tiles[0]?.querySelector('[data-testid="dc-measurement-fx"]')?.getAttribute('data-fx'),
    ).toBe('heat')
    expect(
      tiles[1]?.querySelector('[data-testid="dc-measurement-fx"]')?.getAttribute('data-fx'),
    ).toBe('fall')
    expect(
      tiles[0]?.querySelector('[data-testid="dc-sensor-trend"]')?.getAttribute('data-key'),
    ).toBe('cap:temperature.value')
    expect(tiles[1]?.querySelector('[data-testid="dc-sensor-trend"]')).not.toBeNull()
    // No history kept for this reading: no trend, no motion invented.
    expect(tiles[2]?.querySelector('[data-testid="dc-sensor-trend"]')).toBeNull()
  })

  it('a click opens that reading chart under the card; a second click closes it', () => {
    draw()
    expect(screen.queryByTestId('history-chart')).toBeNull()
    const tiles = screen.getAllByTestId('dc-grid-tile')
    fireEvent.click(nth(tiles, 1))
    expect(screen.getAllByTestId('history-chart')).toHaveLength(1)
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe('cap:humidity.value')
    fireEvent.click(nth(screen.getAllByTestId('dc-grid-tile'), 0))
    expect(screen.getAllByTestId('history-chart')).toHaveLength(1)
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe(
      'cap:temperature.value',
    )
    fireEvent.click(nth(screen.getAllByTestId('dc-grid-tile'), 0))
    expect(screen.queryByTestId('history-chart')).toBeNull()
  })

  it('a reading with no kept history says so instead of drawing an empty chart', () => {
    draw()
    fireEvent.click(nth(screen.getAllByTestId('dc-grid-tile'), 2))
    expect(screen.queryByTestId('history-chart')).toBeNull()
    expect(screen.getByTestId('dc-pie-no-history')).toBeTruthy()
  })
})

describe('MeasuredPieCard in the pie', () => {
  it('is only a pie: each reading is a wedge with its own motion inside it, no tile beside', () => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} showName />)
    expect(screen.getAllByTestId('dc-pie-wedge')).toHaveLength(3)
    expect(screen.queryAllByTestId('dc-pie-tile')).toHaveLength(0)
    expect(screen.queryAllByTestId('dc-grid-tile')).toHaveLength(0)
    const layers = screen.getAllByTestId('dc-pie-fx')
    expect(layers.map((l) => l.getAttribute('data-quantity'))).toContain('temperature')
    expect(
      layers[0]?.querySelector('[data-testid="dc-measurement-fx"]')?.getAttribute('data-fx'),
    ).toBe('heat')
  })

  it('a wedge click opens its chart in the card, a second click closes it', () => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} showName />)
    fireEvent.click(nth(screen.getAllByTestId('dc-pie-wedge'), 0))
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe(
      'cap:temperature.value',
    )
    fireEvent.click(nth(screen.getAllByTestId('dc-pie-wedge'), 0))
    expect(screen.queryByTestId('history-chart')).toBeNull()
  })

  it("the chart is the compact one: no title, the reading's unit, the wedge's own colour slot", () => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} showName />)
    const wedges = screen.getAllByTestId('dc-pie-wedge')
    fireEvent.click(nth(wedges, 1))
    const chart = screen.getByTestId('history-chart')
    expect(chart.getAttribute('data-hide-title')).toBe('true')
    expect(chart.getAttribute('data-units')).toBe('%')
    // Humidity: the first palette slot, the one its wedge wears.
    expect(chart.getAttribute('data-slots')).toBe('0')
    expect(wedges[1]?.querySelector(':scope > path')?.getAttribute('class')).toContain(
      'chart-series-a',
    )
  })

  it('a state reading (motion) opens the same compact chart: a state band with no title, in its own colour', () => {
    const withMotion = [
      measurement('temperature', {}),
      measurement('motion', { band: null, level: null, historyKey: null, reading: null }),
    ]
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={withMotion} showName />)
    fireEvent.click(nth(screen.getAllByTestId('dc-pie-wedge'), 1))
    const chart = screen.getByTestId('state-chart')
    expect(chart.getAttribute('data-keys')).toBe('cap:motion.detected')
    expect(chart.getAttribute('data-hide-title')).toBe('true')
    // Temperature is slot 4, motion the next free preferred one, 5.
    expect(chart.getAttribute('data-slots')).toBe('5')
    expect(screen.queryByTestId('history-chart')).toBeNull()
  })
})
