import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole, DeviceFeature } from '@camstack/types'
import { HaDiscoveredDeviceSchema } from '../ha-discovery-types.js'
import { mapHaEntityToCamStack, inferParentDeviceType } from '../ha-domain-mapping.js'

describe('ha-discovery data shape', () => {
  it('discovered device schema accepts a typical Aqara plug record', () => {
    const sample = {
      haDeviceId: 'd1',
      name: 'Aqara Plug T1',
      area: 'Kitchen',
      manufacturer: 'Aqara',
      model: 'SP-EUC01',
      swVersion: '0.0.0_0042',
      entityCount: 4,
      entities: [
        {
          entityId: 'switch.aqara_plug',
          domain: 'switch',
          name: 'Aqara Plug',
          state: 'on',
          deviceClass: null,
          unitOfMeasurement: null,
          mappedTo: {
            deviceType: DeviceType.Switch,
            role: null,
            capabilities: ['switch'],
          },
          alreadyAdopted: false,
          adoptedCamDeviceId: null,
        },
        {
          entityId: 'sensor.aqara_plug_power',
          domain: 'sensor',
          name: 'Power',
          state: '23.5',
          deviceClass: 'power',
          unitOfMeasurement: 'W',
          mappedTo: {
            deviceType: DeviceType.Sensor,
            role: DeviceRole.PowerSensor,
            capabilities: ['power-meter'],
          },
          alreadyAdopted: false,
          adoptedCamDeviceId: null,
        },
        {
          entityId: 'sensor.aqara_plug_voltage',
          domain: 'sensor',
          name: 'Voltage',
          state: '231',
          deviceClass: 'voltage',
          unitOfMeasurement: 'V',
          mappedTo: {
            deviceType: DeviceType.Sensor,
            role: DeviceRole.VoltageSensor,
            capabilities: ['power-meter'],
          },
          alreadyAdopted: false,
          adoptedCamDeviceId: null,
        },
        {
          entityId: 'sensor.aqara_plug_energy',
          domain: 'sensor',
          name: 'Energy',
          state: '0.85',
          deviceClass: 'energy',
          unitOfMeasurement: 'kWh',
          mappedTo: {
            deviceType: DeviceType.Sensor,
            role: DeviceRole.EnergySensor,
            capabilities: ['power-meter'],
          },
          alreadyAdopted: false,
          adoptedCamDeviceId: null,
        },
      ],
      alreadyAdopted: false,
      adoptedCamDeviceId: null,
    }
    expect(HaDiscoveredDeviceSchema.parse(sample)).toMatchObject({
      haDeviceId: 'd1',
      entityCount: 4,
    })
  })
})

describe('mapHaEntityToCamStack — domain mapping table', () => {
  describe('switch family', () => {
    it('switch with device_class outlet → Switch with the Outlet role (D875)', () => {
      const m = mapHaEntityToCamStack({ domain: 'switch', deviceClass: 'outlet', attributes: {} })
      expect(m).toEqual({
        deviceType: DeviceType.Switch,
        role: DeviceRole.Outlet,
        capabilities: ['switch'],
      })
    })

    it('switch.* → DeviceType.Switch + cap switch', () => {
      const m = mapHaEntityToCamStack({ domain: 'switch', deviceClass: null, attributes: {} })
      expect(m).toEqual({ deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] })
    })

    it('input_boolean → DeviceType.Switch + role BinaryHelper', () => {
      const m = mapHaEntityToCamStack({
        domain: 'input_boolean',
        deviceClass: null,
        attributes: {},
      })
      expect(m?.role).toBe(DeviceRole.BinaryHelper)
    })
  })

  describe('light', () => {
    it('dumb on/off light → switch only', () => {
      const m = mapHaEntityToCamStack({
        domain: 'light',
        deviceClass: null,
        attributes: { supported_color_modes: ['onoff'] },
      })
      expect(m?.capabilities).toEqual(['switch'])
      expect(m?.features).toEqual([])
    })

    it('dimmer (brightness mode) → switch + brightness', () => {
      const m = mapHaEntityToCamStack({
        domain: 'light',
        deviceClass: null,
        attributes: { supported_color_modes: ['brightness'] },
      })
      expect(m?.capabilities).toEqual(['switch', 'brightness'])
    })

    it('CCT bulb (color_temp) → switch + brightness + color + LightColorMired flag', () => {
      const m = mapHaEntityToCamStack({
        domain: 'light',
        deviceClass: null,
        attributes: { supported_color_modes: ['color_temp'] },
      })
      expect(m?.capabilities).toEqual(['switch', 'brightness', 'color'])
      expect(m?.features).toContain(DeviceFeature.LightColorMired)
    })

    it('full Hue (rgb + hs + color_temp) → all three color flags', () => {
      const m = mapHaEntityToCamStack({
        domain: 'light',
        deviceClass: null,
        attributes: { supported_color_modes: ['rgb', 'hs', 'color_temp'] },
      })
      expect(m?.features).toEqual(
        expect.arrayContaining([
          DeviceFeature.LightColorRgb,
          DeviceFeature.LightColorHsv,
          DeviceFeature.LightColorMired,
        ]),
      )
    })
  })

  describe('cover', () => {
    it('basic cover → no position/tilt flags', () => {
      const m = mapHaEntityToCamStack({
        domain: 'cover',
        deviceClass: 'window',
        attributes: { supported_features: 0 },
      })
      expect(m?.deviceType).toBe(DeviceType.Cover)
      expect(m?.features).toEqual([])
    })

    it('positionable cover (SET_POSITION=4) → CoverPositionable flag', () => {
      const m = mapHaEntityToCamStack({
        domain: 'cover',
        deviceClass: 'window',
        attributes: { supported_features: 4 },
      })
      expect(m?.features).toContain(DeviceFeature.CoverPositionable)
    })

    it('the cover KIND (role) follows the HA device_class (D869)', () => {
      const roleOf = (deviceClass: string | null) =>
        mapHaEntityToCamStack({ domain: 'cover', deviceClass, attributes: {} })?.role
      expect(roleOf('blind')).toBe(DeviceRole.CoverBlind)
      expect(roleOf('shade')).toBe(DeviceRole.CoverBlind)
      expect(roleOf('shutter')).toBe(DeviceRole.CoverShutter)
      expect(roleOf('awning')).toBe(DeviceRole.CoverAwning)
      expect(roleOf('curtain')).toBe(DeviceRole.CoverCurtain)
      expect(roleOf('garage')).toBe(DeviceRole.CoverGarage)
      expect(roleOf('gate')).toBe(DeviceRole.CoverGate)
      expect(roleOf('door')).toBe(DeviceRole.CoverDoor)
      expect(roleOf('window')).toBe(DeviceRole.CoverWindow)
      expect(roleOf('damper')).toBeNull()
      expect(roleOf(null)).toBeNull()
    })

    it('positionable + tilt (4 | 128 = 132) → both flags', () => {
      const m = mapHaEntityToCamStack({
        domain: 'cover',
        deviceClass: 'blind',
        attributes: { supported_features: 132 },
      })
      expect(m?.features).toEqual(
        expect.arrayContaining([DeviceFeature.CoverPositionable, DeviceFeature.CoverTilt]),
      )
    })
  })

  describe('lock', () => {
    it('basic lock → no PIN flag', () => {
      const m = mapHaEntityToCamStack({ domain: 'lock', deviceClass: null, attributes: {} })
      expect(m?.features).toEqual([])
    })

    it('PIN-required lock → LockPinRequired flag', () => {
      const m = mapHaEntityToCamStack({
        domain: 'lock',
        deviceClass: null,
        attributes: { code_format: '^\\d{4}$' },
      })
      expect(m?.features).toContain(DeviceFeature.LockPinRequired)
    })

    it('lock with supported_features=1 (OPEN bit) → LockOpen flag', () => {
      const m = mapHaEntityToCamStack({
        domain: 'lock',
        deviceClass: null,
        attributes: { supported_features: 1 },
      })
      expect(m?.features).toContain(DeviceFeature.LockOpen)
    })

    it('lock with supported_features=0 → no LockOpen flag', () => {
      const m = mapHaEntityToCamStack({
        domain: 'lock',
        deviceClass: null,
        attributes: { supported_features: 0 },
      })
      expect(m?.features).not.toContain(DeviceFeature.LockOpen)
    })

    it('lock with PIN + OPEN (supported_features=1 + code_format) → both flags', () => {
      const m = mapHaEntityToCamStack({
        domain: 'lock',
        deviceClass: null,
        attributes: { supported_features: 1, code_format: '^\\d{4}$' },
      })
      expect(m?.features).toContain(DeviceFeature.LockPinRequired)
      expect(m?.features).toContain(DeviceFeature.LockOpen)
    })
  })

  describe('fan', () => {
    it('full ceiling fan (1|2|4|8 = 15) → speed + osc + direction + preset', () => {
      const m = mapHaEntityToCamStack({
        domain: 'fan',
        deviceClass: null,
        attributes: { supported_features: 15 },
      })
      expect(m?.capabilities).toEqual(['switch', 'fan-control'])
      expect(m?.features).toEqual(
        expect.arrayContaining([
          DeviceFeature.FanSpeed,
          DeviceFeature.FanOscillating,
          DeviceFeature.FanDirection,
          DeviceFeature.FanPreset,
        ]),
      )
    })
  })

  describe('climate', () => {
    it('dual-setpoint thermostat (TARGET_TEMPERATURE_RANGE=2) → ClimateDualSetpoint', () => {
      const m = mapHaEntityToCamStack({
        domain: 'climate',
        deviceClass: null,
        attributes: { supported_features: 2 },
      })
      expect(m?.features).toContain(DeviceFeature.ClimateDualSetpoint)
    })
  })

  describe('media_player', () => {
    it('Sonos-like (2|4|32|512|2048 = 2598) → seek + volume + next + play_media + select_source', () => {
      const m = mapHaEntityToCamStack({
        domain: 'media_player',
        deviceClass: null,
        attributes: { supported_features: 2598 },
      })
      expect(m?.features).toEqual(
        expect.arrayContaining([
          DeviceFeature.MediaPlayerSeek,
          DeviceFeature.MediaPlayerVolume,
          DeviceFeature.MediaPlayerNext,
          DeviceFeature.MediaPlayerPlayMedia,
          DeviceFeature.MediaPlayerSelectSource,
        ]),
      )
    })
  })

  describe('sensor (numeric)', () => {
    const sensorCases: ReadonlyArray<{ deviceClass: string; role: DeviceRole; cap: string }> = [
      { deviceClass: 'temperature', role: DeviceRole.TemperatureSensor, cap: 'temperature-sensor' },
      { deviceClass: 'humidity', role: DeviceRole.HumiditySensor, cap: 'humidity-sensor' },
      {
        deviceClass: 'illuminance',
        role: DeviceRole.AmbientLightSensor,
        cap: 'ambient-light-sensor',
      },
      { deviceClass: 'pressure', role: DeviceRole.PressureSensor, cap: 'pressure-sensor' },
      { deviceClass: 'power', role: DeviceRole.PowerSensor, cap: 'power-meter' },
      { deviceClass: 'energy', role: DeviceRole.EnergySensor, cap: 'power-meter' },
      { deviceClass: 'voltage', role: DeviceRole.VoltageSensor, cap: 'power-meter' },
      { deviceClass: 'current', role: DeviceRole.CurrentSensor, cap: 'power-meter' },
      { deviceClass: 'pm25', role: DeviceRole.AirQualitySensor, cap: 'air-quality-sensor' },
      { deviceClass: 'battery', role: DeviceRole.BatterySensor, cap: 'numeric-sensor' },
      { deviceClass: 'enum', role: DeviceRole.EnumSensor, cap: 'enum-sensor' },
    ]
    it.each(sensorCases)('sensor.* with device_class=$deviceClass → $cap cap', ({
      deviceClass,
      role,
      cap,
    }) => {
      const m = mapHaEntityToCamStack({ domain: 'sensor', deviceClass, attributes: {} })
      expect(m?.role).toBe(role)
      expect(m?.capabilities).toEqual([cap])
    })

    it('unknown device_class falls back to numeric-sensor', () => {
      const m = mapHaEntityToCamStack({
        domain: 'sensor',
        deviceClass: 'unknown_thing',
        attributes: {},
      })
      expect(m?.role).toBe(DeviceRole.NumericSensor)
      expect(m?.capabilities).toEqual(['numeric-sensor'])
    })

    it('null device_class (no class) → enum-sensor (string sensor)', () => {
      // Free-text HA sensors (IP address, SSID, firmware version, status text)
      // have device_class=null. Number(stringState) = NaN — must map to
      // enum-sensor so the raw string value is stored and rendered verbatim.
      const m = mapHaEntityToCamStack({ domain: 'sensor', deviceClass: null, attributes: {} })
      expect(m?.role).toBe(DeviceRole.EnumSensor)
      expect(m?.capabilities).toEqual(['enum-sensor'])
    })

    it('null device_class + °C unit → temperature-sensor (helper/statistics)', () => {
      // HA `daily` / template helpers often omit device_class but still expose
      // unit_of_measurement °C — adopt as TemperatureSensor, not free-text enum.
      const m = mapHaEntityToCamStack({
        domain: 'sensor',
        deviceClass: null,
        attributes: { unit_of_measurement: '°C' },
      })
      expect(m?.role).toBe(DeviceRole.TemperatureSensor)
      expect(m?.capabilities).toEqual(['temperature-sensor'])
    })

    it('null device_class + bare % unit stays enum-sensor (ambiguous)', () => {
      // `%` is shared by battery / humidity / many helpers — do not guess.
      const m = mapHaEntityToCamStack({
        domain: 'sensor',
        deviceClass: null,
        attributes: { unit_of_measurement: '%' },
      })
      expect(m?.role).toBe(DeviceRole.EnumSensor)
      expect(m?.capabilities).toEqual(['enum-sensor'])
    })

    it('temperature device_class → numeric-sensor (not enum-sensor)', () => {
      // Regression guard: numeric device_class values must still map to
      // numeric-sensor/specialized caps despite the null→enum-sensor change.
      const m = mapHaEntityToCamStack({
        domain: 'sensor',
        deviceClass: 'temperature',
        attributes: {},
      })
      expect(m?.role).toBe(DeviceRole.TemperatureSensor)
      expect(m?.capabilities).toEqual(['temperature-sensor'])
    })
  })

  describe('binary_sensor', () => {
    const cases: ReadonlyArray<{ deviceClass: string; role: DeviceRole; cap: string }> = [
      { deviceClass: 'motion', role: DeviceRole.MotionSensor, cap: 'motion' },
      { deviceClass: 'door', role: DeviceRole.ContactSensor, cap: 'contact' },
      { deviceClass: 'window', role: DeviceRole.ContactSensor, cap: 'contact' },
      { deviceClass: 'moisture', role: DeviceRole.LeakSensor, cap: 'flood' },
      { deviceClass: 'smoke', role: DeviceRole.SmokeSensor, cap: 'smoke' },
      { deviceClass: 'carbon_monoxide', role: DeviceRole.COSensor, cap: 'carbon-monoxide' },
      { deviceClass: 'gas', role: DeviceRole.GasSensor, cap: 'gas' },
      { deviceClass: 'tamper', role: DeviceRole.TamperSensor, cap: 'tamper' },
      { deviceClass: 'vibration', role: DeviceRole.VibrationSensor, cap: 'vibration' },
      { deviceClass: 'connectivity', role: DeviceRole.ConnectivitySensor, cap: 'connectivity' },
    ]
    it.each(cases)('binary_sensor.* with device_class=$deviceClass → $cap cap', ({
      deviceClass,
      role,
      cap,
    }) => {
      const m = mapHaEntityToCamStack({ domain: 'binary_sensor', deviceClass, attributes: {} })
      expect(m?.role).toBe(role)
      expect(m?.capabilities).toEqual([cap])
    })

    it('unknown device_class falls back to binary cap + BinarySensor role', () => {
      const m = mapHaEntityToCamStack({
        domain: 'binary_sensor',
        deviceClass: null,
        attributes: {},
      })
      expect(m?.role).toBe(DeviceRole.BinarySensor)
      expect(m?.capabilities).toEqual(['binary'])
    })
  })

  describe('control / script / automation / notifier / presence', () => {
    it('input_number → NumericControl', () => {
      const m = mapHaEntityToCamStack({ domain: 'input_number', deviceClass: null, attributes: {} })
      expect(m?.role).toBe(DeviceRole.NumericControl)
      expect(m?.capabilities).toEqual(['control'])
    })

    it('select → SelectControl', () => {
      const m = mapHaEntityToCamStack({ domain: 'select', deviceClass: null, attributes: {} })
      expect(m?.role).toBe(DeviceRole.SelectControl)
    })

    it('script → script-runner', () => {
      const m = mapHaEntityToCamStack({ domain: 'script', deviceClass: null, attributes: {} })
      expect(m?.capabilities).toEqual(['script-runner'])
    })

    it('automation → automation-control', () => {
      const m = mapHaEntityToCamStack({ domain: 'automation', deviceClass: null, attributes: {} })
      expect(m?.capabilities).toEqual(['automation-control'])
    })

    it('notify → notifier cap + GenericNotifier role', () => {
      const m = mapHaEntityToCamStack({ domain: 'notify', deviceClass: null, attributes: {} })
      expect(m?.role).toBe(DeviceRole.GenericNotifier)
      expect(m?.capabilities).toEqual(['notifier'])
    })

    it('person / device_tracker → presence', () => {
      const p = mapHaEntityToCamStack({ domain: 'person', deviceClass: null, attributes: {} })
      const t = mapHaEntityToCamStack({
        domain: 'device_tracker',
        deviceClass: null,
        attributes: {},
      })
      expect(p?.capabilities).toEqual(['presence'])
      expect(t?.capabilities).toEqual(['presence'])
    })
  })

  describe('camera domain', () => {
    // HA `camera.*` entities are modelled as read-only Image devices (the
    // `entity_picture` snapshot URL), NOT streamable Cameras — this keeps the
    // stream-broker out of the picture for snapshot-only sources like a vacuum
    // map. Same shape as the `image.*` domain.
    it('camera → Image device with the image cap (no stream broker)', () => {
      const m = mapHaEntityToCamStack({ domain: 'camera', deviceClass: null, attributes: {} })
      expect(m).not.toBeNull()
      expect(m?.deviceType).toBe(DeviceType.Image)
      expect(m?.capabilities).toContain('image')
      expect(m?.capabilities).not.toContain('snapshot')
    })
  })

  describe('unsupported domains', () => {
    it('unknown domain → null', () => {
      expect(
        mapHaEntityToCamStack({
          domain: 'climate_remote_control',
          deviceClass: null,
          attributes: {},
        }),
      ).toBeNull()
    })
  })
})

describe('inferParentDeviceType', () => {
  it('returns Switch for an Aqara plug device (switch + 3 sensors)', () => {
    const mappings = [
      { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] as const },
      {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.PowerSensor,
        capabilities: ['power-meter'] as const,
      },
      {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.PowerSensor,
        capabilities: ['power-meter'] as const,
      },
      {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.PowerSensor,
        capabilities: ['power-meter'] as const,
      },
    ]
    expect(inferParentDeviceType(mappings)).toBe(DeviceType.Switch)
  })

  it('returns Light when a light entity is present alongside sensors', () => {
    const mappings = [
      {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.MotionSensor,
        capabilities: ['motion'] as const,
      },
      { deviceType: DeviceType.Light, role: null, capabilities: ['switch', 'brightness'] as const },
    ]
    expect(inferParentDeviceType(mappings)).toBe(DeviceType.Light)
  })

  it('returns MediaPlayer when present (highest priority)', () => {
    const mappings = [
      { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] as const },
      { deviceType: DeviceType.MediaPlayer, role: null, capabilities: ['media-player'] as const },
    ]
    expect(inferParentDeviceType(mappings)).toBe(DeviceType.MediaPlayer)
  })

  it('returns Sensor when all entities are sensors', () => {
    const mappings = [
      {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.TemperatureSensor,
        capabilities: ['temperature-sensor'] as const,
      },
      {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.HumiditySensor,
        capabilities: ['humidity-sensor'] as const,
      },
    ]
    expect(inferParentDeviceType(mappings)).toBe(DeviceType.Sensor)
  })

  it('returns Generic when no mappings present', () => {
    expect(inferParentDeviceType([])).toBe(DeviceType.Generic)
  })

  it('returns Generic when all mappings are null (all unsupported)', () => {
    expect(inferParentDeviceType([null, null, null])).toBe(DeviceType.Generic)
  })
})
