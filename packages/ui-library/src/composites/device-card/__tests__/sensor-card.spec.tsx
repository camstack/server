// @vitest-environment jsdom
/**
 * The simple sensor card (#514) on the shared shell: the reading drawn once
 * with its quantity's icon, the backdrop behind it, the shell's state corner;
 * which devices it draws (a sensor with something to set keeps the hero card);
 * and the corner's "since".
 */
import { DeviceType, type HeroModel, type HeroRow, temperatureMeasurement } from '@camstack/types'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { buildModel } from '../../hero-model/__tests__/fixtures'
import { plugFixtures } from '../__fixtures__/plug'
import { readingOf } from '../__fixtures__/pie-readings'
import { sensorFixtures } from '../__fixtures__/sensor'
import { ConnectedSensorCard } from '../connected/ConnectedSensorCard'
import { measurementSinceText } from '../connected/measurement-since'
import { sensorMeasurementOf } from '../scenes/sensor/model'
import { SensorCard } from '../scenes/sensor/SensorCard'

const MINUTE_MS = 60_000
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)

const hub = vi.hoisted(() => ({
  status: 'success' as 'pending' | 'success' | 'error',
  model: null as HeroModel | null,
  /** What the shared card common offers as the device's History view; undefined = the fixture's own. */
  history: undefined as { charts: string | null; events: null } | undefined,
}))

vi.mock('../../../generated/system-hooks', () => ({
  useHeroLayoutGetHeroModel: () => ({
    status: hub.status,
    data: hub.model,
    refetch: () => {},
  }),
  useDeviceManagerGetDevice: () => ({ data: undefined }),
}))
vi.mock('../../hero-model/use-hero-live-refresh', () => ({
  useHeroLiveRefresh: () => {},
}))
vi.mock('../connected/SensorTrend', () => ({ SensorTrend: () => null }))
vi.mock('../../device-history/DeviceHistoryView', () => ({
  DeviceHistoryView: ({ seriesKeys }: { readonly seriesKeys?: readonly string[] }) => (
    <p data-testid="reading-history">{(seriesKeys ?? ['ALL']).join(',')}</p>
  ),
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => {
    const common = plugFixtures(0)[0]?.model.common
    if (common === undefined) throw new Error('no plug fixture')
    return {
      common: {
        ...common,
        power: null,
        consumables: null,
        supply: null,
        remote: null,
        ...(hub.history === undefined ? {} : { history: hub.history }),
      },
      actions: {},
      deviceType: DeviceType.Generic,
      role: null,
      features: [],
      implements: () => true,
      fail: () => {},
      succeed: () => {},
    }
  },
}))

const T0 = 1_700_000_000_000
const powerSensor = (): HeroModel =>
  buildModel(DeviceType.Sensor, ['power-meter'], {
    'power-meter': { power: 1221, lastFetchedAt: T0 },
  })
/** Device 5598: a motion sensor that also reads the light, as the model sends it. */
const motionAndLight = (): HeroModel => ({
  ...powerSensor(),
  measurement: undefined,
  measurements: [
    readingOf('motion', { value: 'Active', tone: 'primary' }),
    readingOf('illuminance', { value: '142', number: 142, unit: 'lx' }),
  ],
})
/** A sensor with a setting the operator can change keeps the full hero card. */
const settableSensor = (): HeroModel => ({ ...powerSensor(), rows: [SETTABLE] })
const SETTABLE: HeroRow = {
  id: 'contact',
  icon: 'plug',
  status: null,
  controls: [
    {
      kind: 'number',
      id: 'offset',
      label: { en: 'Offset', it: 'Offset' },
      value: 0,
      step: null,
      unit: '°C',
      call: { cap: 'temperature-sensor', method: 'setOffset', args: {} },
      valueArg: 'offset',
    },
  ],
}

beforeEach(() => {
  hub.status = 'success'
  hub.model = null
  hub.history = undefined
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})
afterEach(cleanup)

describe('every sensor fixture renders through the shell', () => {
  for (const f of sensorFixtures(NOW)) {
    it(f.id, () => {
      render(<SensorCard model={f.model} orientation={f.orientation} />)
      const values = screen.getAllByTestId('dc-reading-value')
      expect(values).toHaveLength(1)
      expect(values[0]?.textContent).toBe(f.model.reading.value)
      expect(within(screen.getByTestId('dc-state')).getByText(f.model.state.label)).toBeTruthy()
      expect(screen.queryByTestId('dc-measurement-fx') !== null).toBe(f.model.visual !== null)
    })
  }
})

describe('which device the sensor card draws', () => {
  const temp = temperatureMeasurement(48, null)
  it('one measurement and nothing to set', () => {
    expect(sensorMeasurementOf({ measurement: temp, rows: [], gated: [] })).toBe(temp)
  })
  it('no measurement: the hero card', () => {
    expect(sensorMeasurementOf({ rows: [], gated: [] })).toBeNull()
  })
  it('a row the operator can set keeps the hero card, unless it is gated', () => {
    const rows = [SETTABLE]
    expect(sensorMeasurementOf({ measurement: temp, rows, gated: [] })).toBeNull()
    expect(sensorMeasurementOf({ measurement: temp, rows, gated: ['contact'] })).toBe(temp)
  })
})

describe('the corner says since when', () => {
  it('a held state reads the shell duration; a read value reads "ago"; never observed reads nothing', () => {
    const held = measurementSinceText(
      { since: NOW - 12 * MINUTE_MS, sinceKind: 'changed' },
      defaultUiText,
      NOW,
    )
    expect(held).toMatch(/12/)
    expect(held).not.toMatch(/ago/)
    expect(measurementSinceText({ since: null, sinceKind: 'changed' }, defaultUiText, NOW)).toBe(
      null,
    )
    expect(measurementSinceText({ since: 1, sinceKind: 'changed' }, defaultUiText, NOW)).toBeNull()
  })
})

describe('the connected sensor card', () => {
  it('draws the model measurement in the shared card and reports it drawn', () => {
    hub.model = powerSensor()
    const drawn = vi.fn()
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} onDrawn={drawn} />)
    expect(screen.getByTestId('dc-sensor').getAttribute('data-quantity')).toBe('power')
    expect(screen.queryByText('hero')).toBeNull()
    expect(drawn).toHaveBeenCalledWith(true)
  })
  it('falls back for a device that is not a simple sensor, and on an error', () => {
    hub.model = settableSensor()
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} />)
    expect(screen.getByText('hero')).toBeTruthy()
    cleanup()
    hub.status = 'error'
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} />)
    expect(screen.getByText('hero')).toBeTruthy()
  })
  it('device 5598 (motion + light) is drawn as a two-wedge pie, not the legacy hero', () => {
    hub.model = motionAndLight()
    const drawn = vi.fn()
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} onDrawn={drawn} />)
    expect(screen.queryByText('hero')).toBeNull()
    expect(screen.getByTestId('dc-sensor-pie').getAttribute('data-wedges')).toBe('2')
    expect(
      screen.getAllByTestId('dc-pie-wedge').map((w) => w.getAttribute('data-quantity')),
    ).toEqual(['motion', 'illuminance'])
    expect(drawn).toHaveBeenCalledWith(true)
  })
  it('a pie device keeps the full History: the state corner opens it', () => {
    hub.model = motionAndLight()
    hub.history = { charts: 'FULL HISTORY', events: null }
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} />)
    fireEvent.click(screen.getByTestId('dc-state'))
    expect(screen.getByText('FULL HISTORY')).toBeTruthy()
  })
  it("a state wedge (motion) shows its own series only, never the device's whole History", () => {
    hub.model = motionAndLight()
    hub.history = { charts: 'FULL HISTORY', events: null }
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} />)
    fireEvent.click(screen.getAllByTestId('dc-pie-wedge')[0] as Element)
    expect(screen.getByTestId('reading-history').textContent).toBe('cap:motion.detected')
    expect(screen.queryByText('FULL HISTORY')).toBeNull()
    expect(screen.queryByTestId('dc-pie-no-history')).toBeNull()
  })
  it('a wedge with neither a trend nor a state series says so, even when the device has a History', () => {
    hub.model = motionAndLight()
    hub.history = { charts: 'FULL HISTORY', events: null }
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} />)
    fireEvent.click(screen.getAllByTestId('dc-pie-wedge')[1] as Element)
    expect(screen.getByTestId('dc-pie-no-history')).toBeTruthy()
    expect(screen.queryByText('FULL HISTORY')).toBeNull()
  })
  it('selecting a wedge draws its chart inline in the card, with no modal; selecting it again hides it', () => {
    hub.model = motionAndLight()
    hub.history = { charts: 'FULL HISTORY', events: null }
    render(<ConnectedSensorCard deviceId={1} fallback={<p>hero</p>} />)
    expect(screen.queryByTestId('dc-pie-detail')).toBeNull()
    const [motion] = screen.getAllByTestId('dc-pie-wedge')
    fireEvent.click(motion as Element)
    const detail = screen.getByTestId('dc-pie-detail')
    expect(screen.getByTestId('dc-sensor-pie').contains(detail)).toBe(true)
    expect(within(detail).getByTestId('reading-history')).toBeTruthy()
    expect(document.querySelector('dialog[open], [role="dialog"]')).toBeNull()
    fireEvent.click(motion as Element)
    expect(screen.queryByTestId('dc-pie-detail')).toBeNull()
    expect(screen.queryByTestId('reading-history')).toBeNull()
  })
  it('draws the placeholder while the model loads', () => {
    hub.status = 'pending'
    render(<ConnectedSensorCard deviceId={1} placeholder={<p>loading</p>} />)
    expect(screen.getByText('loading')).toBeTruthy()
  })
})
