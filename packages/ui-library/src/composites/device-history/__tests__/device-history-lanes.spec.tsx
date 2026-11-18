// @vitest-environment jsdom
/**
 * The global History block: one lane per unit (on/off series as bands), the
 * Points selector switching lanes, and the single charts stacked below, always visible.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceHistorySeriesInfo } from '@camstack/types'
import { historyLanes } from '../history-lanes'
import { groupDeviceSeries, type HistoryChartSpec } from '../history-model'

const info = (
  key: string,
  over: Partial<DeviceHistorySeriesInfo> = {},
): DeviceHistorySeriesInfo => ({
  key,
  scope: '',
  kind: 'gauge',
  unit: null,
  displayName: key,
  source: 'cap',
  values: null,
  firstTs: 0,
  lastTs: 0,
  ...over,
})

const SERIES: readonly DeviceHistorySeriesInfo[] = [
  info('cap:climate-control.temperature', { unit: '°C', displayName: 'Temperature' }),
  info('cap:climate-control.targetTemperature', { unit: '°C', displayName: 'Target' }),
  info('cap:humidity.value', { unit: '%', displayName: 'Humidity' }),
  info('cap:power-meter.powerW', { unit: 'W', displayName: 'Power' }),
  info('cap:switch.on', { kind: 'boolean', displayName: 'On' }),
  info('cap:contact.open', { kind: 'boolean', displayName: 'Open' }),
]

const gate = vi.hoisted(() => ({ series: [] as readonly DeviceHistorySeriesInfo[] }))

vi.mock('../use-device-history', () => ({
  anchorNow: (now: number) => now,
  readItemId: (item: { key: string }) => item.key,
  useDeviceSeriesList: () => ({
    presence: 'present',
    list: { status: 'ok', data: gate.series },
  }),
  useHistoryReads: () => ({ status: 'pending' }),
}))
vi.mock('../use-device-runs', () => ({ useDeviceRuns: () => undefined }))
vi.mock('../use-history-panels', () => ({
  useHistoryPanels: () => ({
    value: { hidden: {} },
    writable: false,
    update: () => Promise.resolve(),
  }),
}))
vi.mock('../../../hooks/use-url-query', () => ({
  useUrlQueryParam: () => [null, vi.fn()],
}))
vi.mock('../HistoryChart', () => ({
  booleanLabels: () => ({ on: 'on', off: 'off' }),
  HistoryChart: ({ spec }: { spec: HistoryChartSpec }) => (
    <div
      data-testid="chart"
      data-id={spec.id}
      data-series={(spec.type === 'lines' ? spec.series : [spec.series])
        .flat()
        .map((s) => s.key)
        .join(',')}
    />
  ),
}))
vi.mock('../../charts/StateTimeline', () => ({
  StateTimeline: ({ rows }: { rows: readonly { id: string }[] }) => (
    <div data-testid="bands" data-rows={rows.map((r) => r.id).join(',')} />
  ),
}))

import { DeviceHistoryView } from '../DeviceHistoryView'

afterEach(cleanup)

function lanes(): readonly HTMLElement[] {
  return screen.getAllByTestId('dc-history-lane')
}

describe('historyLanes', () => {
  it('makes one line lane per unit and one band lane for the on/off series', () => {
    const charts = groupDeviceSeries(SERIES, (n) => n).flatMap((s) => s.charts)
    const made = historyLanes(charts, (u) => u ?? 'Values')
    const unitLanes = made.filter((l) => l.kind === 'unit')
    expect(unitLanes.map((l) => (l.kind === 'unit' ? l.unit : null)).sort()).toEqual([
      '%',
      'W',
      '°C',
    ])
    const celsius = unitLanes.find((l) => l.kind === 'unit' && l.unit === '°C')
    expect(celsius?.kind === 'unit' ? celsius.spec.series.map((s) => s.key).sort() : []).toEqual([
      'cap:climate-control.targetTemperature',
      'cap:climate-control.temperature',
    ])
    const bands = made.find((l) => l.kind === 'bands')
    expect(bands?.kind === 'bands' ? bands.specs.length : 0).toBe(2)
    expect(made.at(-1)?.kind).toBe('bands')
  })

  it('draws a series two charts carry once', () => {
    const one = info('cap:a.x', { unit: 'W' })
    const spec: HistoryChartSpec = {
      type: 'lines',
      id: 'a',
      title: 'A',
      unit: 'W',
      group: null,
      series: [one],
    }
    const made = historyLanes([spec, { ...spec, id: 'b' }], (u) => u ?? '')
    expect(made).toHaveLength(1)
    expect(made[0]?.kind === 'unit' ? made[0].spec.series : []).toHaveLength(1)
  })
})

describe('DeviceHistoryView lanes', () => {
  it('shows the lanes first and the single charts stacked below, always visible', () => {
    gate.series = SERIES
    render(<DeviceHistoryView deviceId={1} />)
    const ids = lanes().map((l) => l.getAttribute('data-lane'))
    expect(ids).toEqual(expect.arrayContaining(['lane:°C', 'lane:%', 'lane:W', 'bands']))
    expect(lanes().filter((l) => l.getAttribute('data-lane') !== 'bands')).toHaveLength(3)
    expect(screen.queryByTestId('dc-history-singles')).toBeNull()
    expect(screen.queryByText(/Single charts/)).toBeNull()
    const singles = screen
      .getAllByTestId('chart')
      .filter((c) => !(c.getAttribute('data-id') ?? '').startsWith('lane:'))
    expect(singles.length).toBeGreaterThan(0)
  })

  it('the Points selector adds and removes lanes', () => {
    gate.series = SERIES
    render(<DeviceHistoryView deviceId={1} />)
    const trigger = screen.getByTestId('dc-history-points')
    expect(trigger.textContent).toContain('Points 6/6')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('dc-history-points-none'))
    expect(screen.queryAllByTestId('dc-history-lane')).toHaveLength(0)
    expect(screen.getByTestId('dc-history-points').textContent).toContain('Points 0/6')
    fireEvent.click(screen.getByLabelText('Humidity'))
    expect(lanes().map((l) => l.getAttribute('data-lane'))).toEqual(['lane:%'])
    fireEvent.click(screen.getByLabelText('On'))
    const bands = within(lanes()[1] as HTMLElement).getByTestId('bands')
    expect(bands.getAttribute('data-rows')).toContain('switch')
    fireEvent.click(screen.getByTestId('dc-history-points-all'))
    expect(screen.getByTestId('dc-history-points').textContent).toContain('Points 6/6')
  })
})
