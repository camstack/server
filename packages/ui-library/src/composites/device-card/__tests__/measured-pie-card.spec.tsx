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
vi.mock('../../device-history/DeviceHistoryView', () => ({
  DeviceHistoryView: (p: { seriesKeys?: readonly string[] }) => (
    <span data-testid="history-chart" data-keys={(p.seriesKeys ?? []).join(',')} />
  ),
}))

afterEach(cleanup)

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
    fireEvent.click(tiles[1] as HTMLElement)
    expect(screen.getAllByTestId('history-chart')).toHaveLength(1)
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe('cap:humidity.value')
    fireEvent.click(screen.getAllByTestId('dc-grid-tile')[0] as HTMLElement)
    expect(screen.getAllByTestId('history-chart')).toHaveLength(1)
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe(
      'cap:temperature.value',
    )
    fireEvent.click(screen.getAllByTestId('dc-grid-tile')[0] as HTMLElement)
    expect(screen.queryByTestId('history-chart')).toBeNull()
  })

  it('a reading with no kept history says so instead of drawing an empty chart', () => {
    draw()
    fireEvent.click(screen.getAllByTestId('dc-grid-tile')[2] as HTMLElement)
    expect(screen.queryByTestId('history-chart')).toBeNull()
    expect(screen.getByTestId('dc-pie-no-history')).toBeTruthy()
  })
})

describe('MeasuredPieCard in the pie', () => {
  it('every reading is also a tile with the same motion and trend as the grid', () => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} showName />)
    const tiles = screen.getAllByTestId('dc-pie-tile')
    expect(tiles).toHaveLength(3)
    expect(
      tiles[0]?.querySelector('[data-testid="dc-measurement-fx"]')?.getAttribute('data-fx'),
    ).toBe('heat')
    expect(tiles[1]?.querySelector('[data-testid="dc-sensor-trend"]')).not.toBeNull()
    expect(tiles[2]?.querySelector('[data-testid="dc-sensor-trend"]')).toBeNull()
  })

  it('a tile click opens its chart, a second click closes it', () => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} showName />)
    fireEvent.click(screen.getAllByTestId('dc-pie-tile')[1] as HTMLElement)
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe('cap:humidity.value')
    fireEvent.click(screen.getAllByTestId('dc-pie-tile')[1] as HTMLElement)
    expect(screen.queryByTestId('history-chart')).toBeNull()
  })

  it('a wedge click opens its chart, a second click closes it', () => {
    render(<MeasuredPieCard deviceId={1} canActuate={false} shown={shown} showName />)
    fireEvent.click(screen.getAllByTestId('dc-pie-wedge')[0] as Element)
    expect(screen.getByTestId('history-chart').getAttribute('data-keys')).toBe(
      'cap:temperature.value',
    )
    fireEvent.click(screen.getAllByTestId('dc-pie-wedge')[0] as Element)
    expect(screen.queryByTestId('history-chart')).toBeNull()
  })
})
