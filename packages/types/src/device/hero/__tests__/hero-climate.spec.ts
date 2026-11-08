import { describe, expect, it } from 'vitest'
import type { ClimateControlStatus } from '../../../capabilities/climate-control.cap.js'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import type { HeroModel } from '../hero-model.js'
import { projectDeviceRow } from '../hero-row.js'

function build(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown>,
  features: readonly string[] = [],
): HeroModel {
  return buildHeroModel({
    device: { id: 3, type, role: null, name: 'Clima', online: true },
    caps,
    features,
    slices,
    now: 1_700_000_000_000,
    remoteCommands: null,
    access: { canActuate: true },
  })
}

const AC: ClimateControlStatus = {
  mode: 'heat',
  availableModes: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'],
  fanMode: 'auto',
  availableFanModes: ['auto', 'low', 'high'],
  preset: '',
  availablePresets: [],
  target: 22,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: 22.3,
  currentHumidity: 58,
  swingVertical: null,
  swingHorizontal: null,
  minTemp: 16,
  maxTemp: 30,
  tempStep: 1,
  lastFetchedAt: 1,
}

const text = (m: HeroModel): string[] => projectDeviceRow(m).statusLine.map((t) => t.en)

describe('climate hero', () => {
  it('heat at 22 with 22.3 measured', () => {
    const m = build(DeviceType.Climate, ['climate-control'], {
      'climate-control': AC,
    })
    expect(m.state).toBe('on')
    expect(m.scene).toEqual({ id: 'ac', mode: 'heat', level: (22 - 16) / 14 })
    expect(text(m)).toContain('Heat · 22° (22.3°)')
    expect(m.facts.map((f) => f.text.en)).toContain('58%')
    expect(m.ownPower?.on).toBe(true)
    expect(m.ownPower?.turnOff.call).toEqual({
      cap: 'climate-control',
      method: 'setMode',
      args: { mode: 'off' },
    })
    expect(m.rows.map((r) => r.id)).toEqual(['climate-mode', 'climate-fan', 'setpoint'])
    expect(m.sideTiles.left.map((t) => t.value.en)).toEqual(['22.3°', '58%'])
  })

  it('off keeps the setpoint and measured value, and offers a way back on', () => {
    const m = build(DeviceType.Climate, ['climate-control'], {
      'climate-control': {
        ...AC,
        mode: 'off',
        target: 20,
        currentTemp: 19,
        currentHumidity: null,
      },
    })
    expect(m.state).toBe('off')
    expect(m.scene.mode).toBeNull()
    expect(text(m)).toContain('20° (19°)')
    expect(m.ownPower?.on).toBe(false)
    expect(m.ownPower?.turnOn.call.args).toEqual({ mode: 'auto' })
  })

  it('a heat_cool range reads as a range', () => {
    const m = build(DeviceType.Thermostat, ['climate-control'], {
      'climate-control': {
        ...AC,
        mode: 'heat_cool',
        target: null,
        targetLow: 18,
        targetHigh: 24,
      },
    })
    expect(m.scene.id).toBe('thermostat')
    expect(text(m)).toContain('Heat/Cool · 18–24° (22.3°)')
  })

  it('unread is unknown, with no rows and no power', () => {
    const m = build(DeviceType.Climate, ['climate-control'], {})
    expect(m.state).toBe('unknown')
    expect(m.rows).toEqual([])
    expect(m.ownPower).toBeNull()
  })

  it('swing toggles follow the feature', () => {
    const m = build(
      DeviceType.Climate,
      ['climate-control'],
      { 'climate-control': { ...AC, swingVertical: false } },
      [DeviceFeature.ClimateSwingVertical],
    )
    const fan = m.rows.find((r) => r.id === 'climate-fan')
    expect(fan?.controls.some((c) => c.kind === 'toggle' && c.on === false)).toBe(true)
  })

  it('a heating valve sets the thermostat level', () => {
    const m = build(DeviceType.Thermostat, ['climate-control', 'heating-valve'], {
      'climate-control': AC,
      'heating-valve': { position: 38, lastFetchedAt: 1 },
    })
    expect(m.scene.level).toBe(0.38)
    expect(m.facts.map((f) => f.text.en)).toContain('Valve 38%')
  })

  it('water heater: off mode, setpoint slider', () => {
    const m = build(DeviceType.WaterHeater, ['water-heater'], {
      'water-heater': {
        currentTemp: 48,
        targetTemp: 55,
        operationMode: 'eco',
        availableModes: ['off', 'eco', 'electric'],
        away: false,
        minTemp: 30,
        maxTemp: 70,
        lastChangedAt: 1,
      },
    })
    expect(text(m)).toContain('Eco · 55° (48°)')
    expect(m.ownPower?.turnOn.call.args).toEqual({ mode: 'eco' })
    expect(m.rows.find((r) => r.id === 'setpoint')).toBeDefined()
  })
})

describe('sensor heroes', () => {
  it('a temperature sensor carries its reading, not "unknown"', () => {
    const m = build(DeviceType.Sensor, ['temperature-sensor', 'humidity-sensor'], {
      'temperature-sensor': { temperature: 21.4, lastFetchedAt: 1 },
      'humidity-sensor': { humidity: 54, lastFetchedAt: 1 },
    })
    expect(m.scene.id).toBe('sensor-sparkline')
    expect(m.state).toBe('on')
    expect(m.facts.map((f) => f.text.en)).toEqual(['21.4°', '54%'])
  })

  it('a refused sample is unknown, never zero', () => {
    const m = build(DeviceType.Sensor, ['temperature-sensor'], {
      'temperature-sensor': { temperature: null, lastFetchedAt: 1 },
    })
    expect(m.state).toBe('unknown')
    expect(m.facts).toEqual([])
  })

  it('carbon monoxide detected is an alert', () => {
    const m = build(DeviceType.Sensor, ['carbon-monoxide'], {
      'carbon-monoxide': { detected: true, lastChangedAt: 1 },
    })
    expect(m.state).toBe('alert')
  })

  it('air quality lists what the sensor reports', () => {
    const m = build(DeviceType.Sensor, ['air-quality-sensor'], {
      'air-quality-sensor': { co2: 612, pm25: 8, lastFetchedAt: 1 },
    })
    expect(m.facts.map((f) => f.text.en)).toEqual(['CO₂ 612 ppm', 'PM2.5 8 µg/m³'])
  })
})
