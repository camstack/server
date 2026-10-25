import { describe, it, expect } from 'vitest'
import {
  batteryModeForUnit,
  capForQuantity,
  valueFieldForCap,
  roleForQuantity,
  sensorLabel,
  deviceGroupForSensor,
  ECOWITT_DEVICE_GROUPS,
} from '../ecowitt-mapping.js'
import {
  buildEcowittGatewayCandidates,
  groupNativeId,
  type EcowittDiscoverableSensor,
} from '../ecowitt-discovery.js'
import { settingsToEcowittConfig } from '../config.js'
import { DeviceRole, DeviceType } from '@camstack/types'

describe('capForQuantity', () => {
  it('maps temp/humidity/pressure to their dedicated typed caps', () => {
    expect(capForQuantity('temperature')).toBe('temperature-sensor')
    expect(capForQuantity('humidity')).toBe('humidity-sensor')
    expect(capForQuantity('pressure')).toBe('pressure-sensor')
  })
  it('rides numeric-sensor for every other quantity (typed via role)', () => {
    // Weather metrics carry the value on the generic numeric cap; the typed
    // DeviceRole (see roleForQuantity) supplies the icon/label — mirrors how HA
    // maps battery / signal_strength to numeric-sensor + a role.
    expect(capForQuantity('wind_speed')).toBe('numeric-sensor')
    expect(capForQuantity('wind_direction')).toBe('numeric-sensor')
    expect(capForQuantity('precipitation')).toBe('numeric-sensor')
    expect(capForQuantity('precipitation_rate')).toBe('numeric-sensor')
    expect(capForQuantity('uv')).toBe('numeric-sensor')
    expect(capForQuantity('irradiance')).toBe('numeric-sensor')
    expect(capForQuantity('lightning_count')).toBe('numeric-sensor')
    expect(capForQuantity('vpd')).toBe('numeric-sensor')
    // unknown persisted string → numeric-sensor (no throw, no cast)
    expect(capForQuantity('something-new')).toBe('numeric-sensor')
  })
})

describe('valueFieldForCap', () => {
  it('returns the canonical value field per cap', () => {
    expect(valueFieldForCap('temperature-sensor')).toBe('celsius')
    expect(valueFieldForCap('humidity-sensor')).toBe('percent')
    expect(valueFieldForCap('pressure-sensor')).toBe('hpa')
    expect(valueFieldForCap('ambient-light-sensor')).toBe('lux')
    expect(valueFieldForCap('numeric-sensor')).toBe('value')
  })
})

describe('roleForQuantity', () => {
  it('maps temp/humidity/pressure to their sensor roles', () => {
    expect(roleForQuantity('temperature')).toBe(DeviceRole.TemperatureSensor)
    expect(roleForQuantity('humidity')).toBe(DeviceRole.HumiditySensor)
    expect(roleForQuantity('pressure')).toBe(DeviceRole.PressureSensor)
  })
  it('types weather metrics via role while riding numeric-sensor', () => {
    expect(roleForQuantity('wind_speed')).toBe(DeviceRole.WindSensor)
    expect(roleForQuantity('wind_direction')).toBe(DeviceRole.WindSensor)
    expect(roleForQuantity('precipitation')).toBe(DeviceRole.RainSensor)
    expect(roleForQuantity('precipitation_rate')).toBe(DeviceRole.RainSensor)
    expect(roleForQuantity('uv')).toBe(DeviceRole.UvSensor)
    // irradiance = solar radiation (W/m²), distinct from ambient light (lux)
    expect(roleForQuantity('irradiance')).toBe(DeviceRole.SolarRadiationSensor)
  })
  it('falls back to NumericSensor for untyped quantities', () => {
    expect(roleForQuantity('lightning_count')).toBe(DeviceRole.NumericSensor)
    expect(roleForQuantity('vpd')).toBe(DeviceRole.NumericSensor)
    expect(roleForQuantity('something-new')).toBe(DeviceRole.NumericSensor)
  })
})

describe('batteryModeForUnit', () => {
  it('maps a percent battery to the typed battery cap', () => {
    expect(batteryModeForUnit('%')).toBe('percent')
  })
  it('maps a raw-voltage battery to a numeric-sensor (V)', () => {
    expect(batteryModeForUnit('V')).toBe('voltage')
  })
  it('maps an absent battery unit to none', () => {
    expect(batteryModeForUnit(undefined)).toBe('none')
  })
})

describe('sensorLabel', () => {
  it('labels with optional channel', () => {
    expect(sensorLabel('temperature', undefined)).toBe('Temperature')
    expect(sensorLabel('temperature', 2)).toBe('Temperature CH2')
    expect(sensorLabel('wind_speed', undefined)).toBe('Wind speed')
    // unknown quantity falls back to its raw string
    expect(sensorLabel('mystery', 1)).toBe('mystery CH1')
  })

  it('prefers the specific measurement name over the quantity label', () => {
    // Same-quantity sensors are now distinguishable by their name.
    expect(sensorLabel('temperature', undefined, 'Outdoor Temperature')).toBe('Outdoor Temperature')
    expect(sensorLabel('temperature', undefined, 'Dewpoint Temperature')).toBe(
      'Dewpoint Temperature',
    )
    expect(sensorLabel('wind_speed', undefined, 'Wind Gust')).toBe('Wind Gust')
    // a channel is still appended when present
    expect(sensorLabel('temperature', 2, 'Soil Temperature')).toBe('Soil Temperature CH2')
    // empty/absent name falls back to the quantity label
    expect(sensorLabel('temperature', undefined, '')).toBe('Temperature')
    expect(sensorLabel('temperature', undefined, undefined)).toBe('Temperature')
  })

  it('derives a specific name from the field key when the library left none (push path)', () => {
    // The push/named-and-pattern-key path leaves `name` absent, so without the
    // field-key fallback every same-quantity reading would collide on one
    // generic label. Disambiguate via the field key embedded in the sensor id.

    // The 5+ rain readings — all quantity 'precipitation', no library name.
    expect(sensorLabel('precipitation_rate', undefined, undefined, 'gateway:rainratein')).toBe(
      'Rain Rate',
    )
    expect(sensorLabel('precipitation', undefined, undefined, 'gateway:eventrainin')).toBe(
      'Rain Event',
    )
    expect(sensorLabel('precipitation', undefined, undefined, 'gateway:hourlyrainin')).toBe(
      'Hourly Rain',
    )
    expect(sensorLabel('precipitation', undefined, undefined, 'gateway:dailyrainin')).toBe(
      'Daily Rain',
    )
    expect(sensorLabel('precipitation', undefined, undefined, 'gateway:weeklyrainin')).toBe(
      'Weekly Rain',
    )
    expect(sensorLabel('precipitation', undefined, undefined, 'gateway:monthlyrainin')).toBe(
      'Monthly Rain',
    )
    expect(sensorLabel('precipitation', undefined, undefined, 'gateway:yearlyrainin')).toBe(
      'Yearly Rain',
    )

    // Indoor vs outdoor temperature / humidity (both shared a generic label).
    expect(sensorLabel('temperature', undefined, undefined, 'gateway:tempinf')).toBe(
      'Indoor Temperature',
    )
    expect(sensorLabel('temperature', undefined, undefined, 'AABB:station:tempf')).toBe(
      'Outdoor Temperature',
    )
    expect(sensorLabel('humidity', undefined, undefined, 'gateway:humidityin')).toBe(
      'Indoor Humidity',
    )
    expect(sensorLabel('humidity', undefined, undefined, 'AABB:station:humidity')).toBe(
      'Outdoor Humidity',
    )

    // Pressure, wind, solar/uv, lightning.
    expect(sensorLabel('pressure', undefined, undefined, 'gateway:baromrelin')).toBe(
      'Relative Pressure',
    )
    expect(sensorLabel('pressure', undefined, undefined, 'gateway:baromabsin')).toBe(
      'Absolute Pressure',
    )
    expect(sensorLabel('wind_speed', undefined, undefined, 'AABB:station:windgustmph')).toBe(
      'Wind Gust',
    )
    expect(sensorLabel('irradiance', undefined, undefined, 'AABB:station:solarradiation')).toBe(
      'Solar Radiation',
    )
    expect(sensorLabel('lightning_count', undefined, undefined, 'AABB:station:lightning_num')).toBe(
      'Lightning Count',
    )

    // Piezo rain variants resolve to the same vocabulary as the tipping-bucket.
    expect(sensorLabel('precipitation', undefined, undefined, 'AABB:station:drain_piezo')).toBe(
      'Daily Rain',
    )
  })

  it('field key wins over a (possibly stale) name; falls back to name then generic', () => {
    // The raw field key is authoritative: a persisted `name` may be a STALE
    // GENERIC label, so the known field-key vocabulary takes priority.
    expect(sensorLabel('temperature', undefined, 'Temperature', 'hw:tempinf')).toBe(
      'Indoor Temperature',
    )
    // A channel suffix is still appended onto a field-key-derived base.
    expect(sensorLabel('temperature', 3, undefined, 'AABB:ch3:temp3f')).toBe(
      // temp3f is channel-suffixed (not in the table) → generic + CH3
      'Temperature CH3',
    )
    // Unknown field key but a specific library name present → the name is used.
    expect(sensorLabel('temperature', undefined, 'Greenhouse Temp', 'gateway:somethingnew')).toBe(
      'Greenhouse Temp',
    )
    // Unknown field key and no name → generic quantity label.
    expect(sensorLabel('temperature', undefined, undefined, 'gateway:somethingnew')).toBe(
      'Temperature',
    )
  })
})

describe('deviceGroupForSensor (1→3 split)', () => {
  it('weather-station category → weather-station group', () => {
    expect(deviceGroupForSensor('weather-station', undefined)).toBe('weather-station')
    expect(deviceGroupForSensor('weather-station', 1)).toBe('weather-station')
  })
  it('channel-sensor on channel 1 → temp-sensor-ch1 (the CH1 split-out)', () => {
    expect(deviceGroupForSensor('channel-sensor', 1)).toBe('temp-sensor-ch1')
  })
  it('channel-sensors on CH2..8 fall under gateway (documented grouping choice)', () => {
    for (const ch of [2, 3, 4, 5, 6, 7, 8]) {
      expect(deviceGroupForSensor('channel-sensor', ch)).toBe('gateway')
    }
  })
  it('gateway / external categories → gateway', () => {
    expect(deviceGroupForSensor('gateway', undefined)).toBe('gateway')
    expect(deviceGroupForSensor('external', undefined)).toBe('gateway')
  })
  it('an absent category defaults to gateway (safe default)', () => {
    expect(deviceGroupForSensor(undefined, undefined)).toBe('gateway')
    expect(deviceGroupForSensor(undefined, 5)).toBe('gateway')
  })
})

describe('buildEcowittGatewayCandidates (3 group containers)', () => {
  const SENSORS: readonly EcowittDiscoverableSensor[] = [
    // weather-station: a WS90 wind reading
    {
      id: 's-wind',
      quantity: 'wind_speed',
      channel: undefined,
      model: 'ws90',
      category: 'weather-station',
    },
    // temp-sensor-ch1: a WH31 temp/hum on channel 1
    {
      id: 's-ch1-temp',
      quantity: 'temperature',
      channel: 1,
      model: 'wh31',
      category: 'channel-sensor',
    },
    {
      id: 's-ch1-hum',
      quantity: 'humidity',
      channel: 1,
      model: 'wh31',
      category: 'channel-sensor',
    },
    // gateway: indoor reading (no model → gateway)
    {
      id: 's-indoor',
      quantity: 'temperature',
      channel: undefined,
      model: undefined,
      category: 'gateway',
    },
    // gateway: a CH2 channel-sensor (CH2..8 grouped under gateway)
    {
      id: 's-ch2-temp',
      quantity: 'temperature',
      channel: 2,
      model: 'wh31',
      category: 'channel-sensor',
    },
    // gateway: an external lightning sensor
    {
      id: 's-lightning',
      quantity: 'lightning_count',
      channel: undefined,
      model: 'wh57',
      category: 'external',
    },
  ]

  it('returns exactly three Container candidates, one per device group', () => {
    const candidates = buildEcowittGatewayCandidates({
      gatewayId: 'ecowitt_001',
      gatewayName: 'Garden GW2000',
      sensors: SENSORS,
      adoptedDeviceIdByGroup: {},
    })
    expect(candidates).toHaveLength(3)
    expect(candidates.map((c) => c.childNativeId)).toEqual(
      ECOWITT_DEVICE_GROUPS.map((g) => groupNativeId('ecowitt_001', g)),
    )
    for (const c of candidates) {
      expect(c.type).toBe(DeviceType.Container)
      expect(c.status).toBe('online')
    }
  })

  it('routes each sensor into the right group container', () => {
    const candidates = buildEcowittGatewayCandidates({
      gatewayId: 'ecowitt_001',
      gatewayName: 'GW',
      sensors: SENSORS,
      adoptedDeviceIdByGroup: {},
    })
    const byGroup = new Map(
      ECOWITT_DEVICE_GROUPS.map((g) => [
        g,
        candidates.find((c) => c.childNativeId === groupNativeId('ecowitt_001', g)),
      ]),
    )
    const ids = (g: 'gateway' | 'weather-station' | 'temp-sensor-ch1'): string[] =>
      (byGroup.get(g)?.children ?? []).map((c) => c.childNativeId).sort()

    expect(ids('weather-station')).toEqual(['s-wind'])
    expect(ids('temp-sensor-ch1')).toEqual(['s-ch1-hum', 's-ch1-temp'])
    // gateway absorbs the indoor reading, the CH2 channel-sensor, and the external sensor
    expect(ids('gateway')).toEqual(['s-ch2-temp', 's-indoor', 's-lightning'])
  })

  it('maps each sensor child to its quantity cap', () => {
    const candidates = buildEcowittGatewayCandidates({
      gatewayId: 'b',
      gatewayName: 'GW',
      sensors: SENSORS,
      adoptedDeviceIdByGroup: {},
    })
    const wsCandidate = candidates.find(
      (c) => c.childNativeId === groupNativeId('b', 'weather-station'),
    )
    const windChild = wsCandidate?.children?.find((c) => c.childNativeId === 's-wind')
    expect(windChild?.capabilities).toEqual(['numeric-sensor'])
    expect(windChild?.type).toBe(DeviceType.Sensor)

    const ch1Candidate = candidates.find(
      (c) => c.childNativeId === groupNativeId('b', 'temp-sensor-ch1'),
    )
    const tempChild = ch1Candidate?.children?.find((c) => c.childNativeId === 's-ch1-temp')
    expect(tempChild?.capabilities).toEqual(['temperature-sensor'])
  })

  it('reports per-group adopted state from adoptedDeviceIdByGroup', () => {
    const candidates = buildEcowittGatewayCandidates({
      gatewayId: 'b',
      gatewayName: 'GW',
      sensors: [],
      adoptedDeviceIdByGroup: { gateway: 42, 'weather-station': null },
    })
    const gw = candidates.find((c) => c.childNativeId === groupNativeId('b', 'gateway'))
    const ws = candidates.find((c) => c.childNativeId === groupNativeId('b', 'weather-station'))
    const ch1 = candidates.find((c) => c.childNativeId === groupNativeId('b', 'temp-sensor-ch1'))
    expect(gw?.alreadyAdopted).toBe(true)
    expect(gw?.adoptedDeviceId).toBe(42)
    expect(ws?.alreadyAdopted).toBe(false)
    expect(ch1?.alreadyAdopted).toBe(false)
  })

  it('still yields all three containers when a group has no sensors', () => {
    const candidates = buildEcowittGatewayCandidates({
      gatewayId: 'b',
      gatewayName: 'GW',
      sensors: [],
      adoptedDeviceIdByGroup: {},
    })
    expect(candidates).toHaveLength(3)
    for (const c of candidates) expect(c.children).toEqual([])
  })
})

describe('settingsToEcowittConfig', () => {
  it('defaults to the local transport + applies defaults', () => {
    const cfg = settingsToEcowittConfig({ host: '192.168.10.50' })
    expect(cfg.transport).toBe('local')
    if (cfg.transport === 'local') {
      expect(cfg.host).toBe('192.168.10.50')
      expect(cfg.port).toBe(80)
      expect(cfg.pollIntervalMs).toBe(60_000)
    }
  })
  it('parses a listener transport', () => {
    const cfg = settingsToEcowittConfig({ transport: 'listener', listenPort: 5000 })
    expect(cfg.transport).toBe('listener')
    if (cfg.transport === 'listener') {
      expect(cfg.listenPort).toBe(5000)
    }
  })
})
