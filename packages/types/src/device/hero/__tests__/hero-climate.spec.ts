import { describe, expect, it } from 'vitest'
import type { ClimateControlStatus, HvacMode } from '../../../capabilities/climate-control.cap.js'
import { DeviceFeature, DeviceRole, DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import type { HeroModel } from '../hero-model.js'
import { projectDeviceRow } from '../hero-row.js'

/** An air conditioner: a `climate` device with role `climate-ac` (D1033). */
const AC = 'climate+climate-ac'

function build(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown>,
  features: readonly string[] = [],
): HeroModel {
  return buildHeroModel({
    device: {
      id: 3,
      ...(type === AC
        ? { type: DeviceType.Climate, role: DeviceRole.ClimateAc }
        : { type, role: null }),
      name: 'Clima',
      online: true,
    },
    caps,
    features,
    slices,
    now: 1_700_000_000_000,
    remoteCommands: null,
    access: { canActuate: true },
  })
}

const AC_STATUS: ClimateControlStatus = {
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
    const m = build(AC, ['climate-control'], {
      'climate-control': AC_STATUS,
    })
    expect(m.state).toBe('on')
    expect(m.scene).toEqual({ id: 'ac', mode: 'heat', level: (22 - 16) / 14 })
    expect(m.title.en).toBe('Heating')
    expect(text(m)).toEqual(['Heating', '22° (22.3°)', '58%'])
    expect(m.look).toMatchObject({ icon: 'flame', tone: 'warning', background: 'heat-rise' })
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

  it('the scene caption names the mode and the fan; the title stays the mode', () => {
    const m = build(AC, ['climate-control'], { 'climate-control': AC_STATUS })
    expect(m.title.en).toBe('Heating')
    expect(m.caption).toEqual({ en: 'Heating · fan Auto', it: 'Riscalda · ventola Auto' })
  })

  it('mode and fan options carry readable labels', () => {
    const m = build(AC, ['climate-control'], { 'climate-control': AC_STATUS })
    const row = (id: string) => m.rows.find((r) => r.id === id)?.controls[0]
    const mode = row('climate-mode')
    const fan = row('climate-fan')
    expect(mode?.kind === 'picker' ? mode.optionLabels?.['dry']?.it : null).toBe('Deum.')
    expect(fan?.kind === 'picker' ? fan.optionLabels?.['low']?.it : null).toBe('Bassa')
  })

  it('the mode picker carries Off as its last segment, so the card needs no power row', () => {
    const m = build(AC, ['climate-control'], { 'climate-control': AC_STATUS })
    const mode = m.rows.find((r) => r.id === 'climate-mode')?.controls[0]
    expect(mode?.kind === 'picker' ? mode.options.at(-1) : null).toBe('off')
    expect(mode?.kind === 'picker' ? mode.optionLabels?.['off']?.it : null).toBe('Spento')
  })

  it('the integration is a chip, first among the badges', () => {
    const m = buildHeroModel({
      device: {
        id: 3,
        type: DeviceType.Climate,
        role: DeviceRole.ClimateAc,
        name: 'Clima',
        online: true,
        integration: 'Midea',
      },
      caps: ['climate-control'],
      features: [],
      slices: { 'climate-control': AC_STATUS },
      now: 1_700_000_000_000,
      remoteCommands: null,
      access: { canActuate: true },
    })
    expect(m.badges[0]).toMatchObject({ id: 'integration', label: { en: 'Midea', it: 'Midea' } })
    expect(build(AC, ['climate-control'], { 'climate-control': AC_STATUS }).badges).toEqual([])
  })

  it('off keeps the setpoint and measured value, and offers a way back on', () => {
    const m = build(AC, ['climate-control'], {
      'climate-control': {
        ...AC_STATUS,
        mode: 'off',
        target: 20,
        currentTemp: 19,
        currentHumidity: null,
      },
    })
    expect(m.state).toBe('off')
    expect(m.scene.mode).toBeNull()
    expect(text(m)).toEqual(['Off', '20° (19°)'])
    expect(m.title.it).toBe('Spento')
    expect(m.look).toMatchObject({ icon: 'snowflake', tone: 'muted' })
    expect(m.ownPower?.on).toBe(false)
    expect(m.ownPower?.turnOn.call.args).toEqual({ mode: 'auto' })
  })

  it('a heat_cool range reads as a range', () => {
    const m = build(DeviceType.Climate, ['climate-control'], {
      'climate-control': {
        ...AC_STATUS,
        mode: 'heat_cool',
        target: null,
        targetLow: 18,
        targetHigh: 24,
      },
    })
    expect(m.scene.id).toBe('thermostat')
    expect(text(m)).toEqual(['Heat/Cool', '18–24° (22.3°)', '58%'])
    expect(m.look.icon).toBe('thermometer')
  })

  it('unread is unknown, with no rows and no power', () => {
    const m = build(AC, ['climate-control'], {})
    expect(m.state).toBe('unknown')
    expect(m.rows).toEqual([])
    expect(m.ownPower).toBeNull()
  })

  it('swing toggles follow the feature', () => {
    const m = build(
      AC,
      ['climate-control'],
      { 'climate-control': { ...AC_STATUS, swingVertical: false } },
      [DeviceFeature.ClimateSwingVertical],
    )
    const fan = m.rows.find((r) => r.id === 'climate-fan')
    expect(fan?.controls.some((c) => c.kind === 'toggle' && c.on === false)).toBe(true)
  })

  it('a heating valve sets the thermostat level', () => {
    const m = build(DeviceType.Climate, ['climate-control', 'heating-valve'], {
      'climate-control': AC_STATUS,
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
    expect(text(m)).toEqual(['Eco', '55° (48°)'])
    expect(m.look).toMatchObject({ icon: 'thermometer-sun', tone: 'warning' })
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
    expect(m.title.en).toBe('21.4°')
    expect(m.facts.map((f) => f.text.en)).toEqual(['21.4°', '54%'])
    expect(m.look.icon).toBe('gauge')
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
    expect(m.title.en).toBe('CO detected')
  })

  it('air quality lists what the sensor reports', () => {
    const m = build(DeviceType.Sensor, ['air-quality-sensor'], {
      'air-quality-sensor': { co2: 612, pm25: 8, lastFetchedAt: 1 },
    })
    expect(m.facts.map((f) => f.text.en)).toEqual(['CO₂ 612 ppm', 'PM2.5 8 µg/m³'])
    expect(m.sideTiles.right.map((t) => [t.label.en, t.value.en])).toEqual([
      ['CO₂', '612 ppm'],
      ['PM2.5', '8 µg/m³'],
    ])
  })

  it('each sensor role has its own icon and a reading headline, never on/off', () => {
    const cases: [string, string, string, Record<string, unknown>, string, string][] = [
      [
        'temperature-sensor',
        'temperature-sensor',
        'thermometer',
        { temperature: 21.4, lastFetchedAt: 1 },
        '21.4°',
        'info',
      ],
      [
        'humidity-sensor',
        'humidity-sensor',
        'droplets',
        { humidity: 55, lastFetchedAt: 1 },
        '55%',
        'info',
      ],
      [
        'air-quality-sensor',
        'air-quality-sensor',
        'wind',
        { aqi: 30, lastFetchedAt: 1 },
        'Good',
        'success',
      ],
      [
        'ambient-light-sensor',
        'ambient-light-sensor',
        'sun',
        { illuminance: 320, lastFetchedAt: 1 },
        '320 lx',
        'warning',
      ],
      [
        'pressure-sensor',
        'pressure-sensor',
        'gauge',
        { pressure: 1013, lastFetchedAt: 1 },
        '1013 hPa',
        'info',
      ],
    ]
    const roles: Record<string, string> = {
      'temperature-sensor': 'temperature-sensor',
      'humidity-sensor': 'humidity-sensor',
      'air-quality-sensor': 'air-quality-sensor',
      'ambient-light-sensor': 'ambient-light-sensor',
      'pressure-sensor': 'pressure-sensor',
    }
    for (const [cap, , icon, slice, title, tone] of cases) {
      const m = buildHeroModel({
        device: {
          id: 1,
          type: DeviceType.Sensor,
          role: roles[cap] ?? null,
          name: 's',
          online: true,
        },
        caps: [cap],
        features: [],
        slices: { [cap]: slice },
        now: 1,
        remoteCommands: null,
        access: { canActuate: true },
      })
      expect(m.title.en, cap).toBe(title)
      expect(m.look, cap).toMatchObject({ icon, tone })
    }
  })
})

describe('power on restores the last mode', () => {
  const off = { ...AC_STATUS, mode: 'off' as const }
  it('heat, then off: on sends heat', () => {
    const m = build(AC, ['climate-control'], {
      'climate-control': { ...off, lastActiveMode: 'heat' },
    })
    expect(m.ownPower?.turnOn.call.args).toEqual({ mode: 'heat' })
  })
  it('a device that never reported a mode falls back to the fixed order', () => {
    const m = build(AC, ['climate-control'], { 'climate-control': off })
    expect(m.ownPower?.turnOn.call.args).toEqual({ mode: 'auto' })
  })
  it('a remembered mode the device no longer accepts falls back', () => {
    const m = build(AC, ['climate-control'], {
      'climate-control': { ...off, availableModes: ['off', 'cool'], lastActiveMode: 'heat' },
    })
    expect(m.ownPower?.turnOn.call.args).toEqual({ mode: 'cool' })
  })
})

describe('climate looks by mode', () => {
  const modes: [HvacMode, string, string, string][] = [
    ['heat', 'flame', 'warning', 'Heating'],
    ['cool', 'snowflake', 'info', 'Cooling'],
    ['dry', 'droplets', 'info', 'Drying'],
    ['fan_only', 'fan', 'primary', 'Fan only'],
    ['auto', 'thermometer', 'success', 'Auto'],
  ]
  for (const [mode, icon, tone, title] of modes) {
    it(`${mode}: ${icon}, ${tone}, "${title}"`, () => {
      const m = build(AC, ['climate-control'], {
        'climate-control': { ...AC_STATUS, mode },
      })
      expect(m.look).toMatchObject({ icon, tone })
      expect(m.title.en).toBe(title)
    })
  }
  it('a thermostat on heat uses the same mode picture', () => {
    const m = build(DeviceType.Climate, ['climate-control'], { 'climate-control': AC_STATUS })
    expect(m.look.icon).toBe('flame')
  })
  it('unread climate keeps its own icon, quiet — not a mode, not a question mark', () => {
    const m = build(AC, ['climate-control'], {})
    expect(m.state).toBe('unknown')
    expect(m.look).toMatchObject({ icon: 'snowflake', tone: 'muted', animation: 'none' })
    expect(m.title.en).toBe('—')
  })
})
