import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import type { HmDataPoint, HmDevice, HmValue } from 'nodehomematic'
import {
  mapMaintenanceChannel,
  mapFirmwareUpdate,
  readReachability,
} from '../homematic-diagnostics-mapping.js'

// ── Fixture builders, typed against the real lib types (no casts) ──────────

interface DataPointSeed {
  readonly parameter: string
  readonly type?: string
  readonly value?: HmValue
  readonly unit?: string
  readonly min?: number
  readonly max?: number
}

function dataPoint(seed: DataPointSeed): HmDataPoint {
  return {
    id: `dp:${seed.parameter.toLowerCase()}`,
    parameter: seed.parameter,
    type: seed.type ?? 'FLOAT',
    value: seed.value ?? null,
    unit: seed.unit,
    readable: true,
    writable: false,
    hasEvents: true,
    min: seed.min,
    max: seed.max,
  }
}

interface DeviceSeed {
  readonly maintenance?: readonly DataPointSeed[]
  readonly withoutMaintenanceChannel?: boolean
  readonly firmware?: string
  readonly availableFirmware?: string
  readonly updatable?: boolean
  readonly firmwareUpdateState?: string
}

function hmDevice(seed: DeviceSeed): HmDevice {
  const channels = seed.withoutMaintenanceChannel
    ? [{ address: 'DEV:1', index: 1, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] }]
    : [
        {
          address: 'DEV:0',
          index: 0,
          type: 'MAINTENANCE',
          dataPoints: (seed.maintenance ?? []).map(dataPoint),
        },
      ]
  return {
    address: 'DEV',
    type: 'HmIP-TEST',
    name: 'Test device',
    firmware: seed.firmware,
    availableFirmware: seed.availableFirmware,
    updatable: seed.updatable,
    firmwareUpdateState: seed.firmwareUpdateState,
    channels,
  }
}

describe('mapMaintenanceChannel', () => {
  it('maps a battery device MAINTENANCE channel to voltage + rssi + duty-cycle entities', () => {
    const device = hmDevice({
      maintenance: [
        { parameter: 'LOW_BAT', type: 'BOOL', value: false },
        { parameter: 'OPERATING_VOLTAGE', type: 'FLOAT', value: 2.9, unit: 'V' },
        { parameter: 'RSSI_DEVICE', type: 'INTEGER', value: -62, unit: 'dBm' },
        { parameter: 'DUTY_CYCLE', type: 'FLOAT', value: 12, unit: '%' },
      ],
    })

    const entities = mapMaintenanceChannel(device)
    const keys = entities.map((e) => e.key)

    // OPERATING_VOLTAGE present → prefer voltage over LOW_BAT (no battery-low).
    expect(keys).toContain('maint-voltage')
    expect(keys).not.toContain('maint-battery-low')
    expect(keys).toContain('maint-rssi-device')
    expect(keys).toContain('maint-duty-cycle')

    const voltage = entities.find((e) => e.key === 'maint-voltage')
    expect(voltage).toEqual({
      key: 'maint-voltage',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.VoltageSensor,
      capabilities: ['numeric-sensor'],
      name: 'Operating voltage',
      unit: 'V',
      sourceParams: ['OPERATING_VOLTAGE'],
    })
  })

  it('emits the battery-low binary entity when there is no OPERATING_VOLTAGE', () => {
    const device = hmDevice({
      maintenance: [
        { parameter: 'LOW_BAT', type: 'BOOL', value: true },
        { parameter: 'RSSI_DEVICE', type: 'INTEGER', value: -70, unit: 'dBm' },
      ],
    })

    const entities = mapMaintenanceChannel(device)
    const batteryLow = entities.find((e) => e.key === 'maint-battery-low')
    expect(batteryLow).toEqual({
      key: 'maint-battery-low',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.BatterySensor,
      capabilities: ['binary'],
      name: 'Battery low',
      sourceParams: ['LOW_BAT'],
    })
    expect(entities.find((e) => e.key === 'maint-voltage')).toBeUndefined()
  })

  it('maps RSSI_DEVICE and RSSI_PEER to numeric-sensor dBm entities', () => {
    const device = hmDevice({
      maintenance: [
        { parameter: 'RSSI_DEVICE', value: -50, unit: 'dBm' },
        { parameter: 'RSSI_PEER', value: -55, unit: 'dBm' },
      ],
    })
    const entities = mapMaintenanceChannel(device)

    expect(entities.find((e) => e.key === 'maint-rssi-device')).toEqual({
      key: 'maint-rssi-device',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.NumericSensor,
      capabilities: ['numeric-sensor'],
      name: 'Signal (device)',
      unit: 'dBm',
      sourceParams: ['RSSI_DEVICE'],
    })
    expect(entities.find((e) => e.key === 'maint-rssi-peer')).toEqual({
      key: 'maint-rssi-peer',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.NumericSensor,
      capabilities: ['numeric-sensor'],
      name: 'Signal (peer)',
      unit: 'dBm',
      sourceParams: ['RSSI_PEER'],
    })
  })

  it('maps a numeric DUTY_CYCLE to numeric-sensor (%) and a boolean DUTY_CYCLE to binary', () => {
    const numeric = mapMaintenanceChannel(
      hmDevice({ maintenance: [{ parameter: 'DUTY_CYCLE', type: 'FLOAT', value: 7, unit: '%' }] }),
    )
    expect(numeric.find((e) => e.key === 'maint-duty-cycle')).toEqual({
      key: 'maint-duty-cycle',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.NumericSensor,
      capabilities: ['numeric-sensor'],
      name: 'Duty cycle',
      unit: '%',
      sourceParams: ['DUTY_CYCLE'],
    })

    const boolean = mapMaintenanceChannel(
      hmDevice({ maintenance: [{ parameter: 'DUTY_CYCLE', type: 'BOOL', value: true }] }),
    )
    expect(boolean.find((e) => e.key === 'maint-duty-cycle')).toEqual({
      key: 'maint-duty-cycle',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.BinarySensor,
      capabilities: ['binary'],
      name: 'Duty cycle',
      sourceParams: ['DUTY_CYCLE'],
    })
  })

  it('maps OPERATING_TEMPERATURE / ACTUAL_TEMPERATURE on MAINTENANCE to a temperature entity', () => {
    const op = mapMaintenanceChannel(
      hmDevice({
        maintenance: [{ parameter: 'OPERATING_TEMPERATURE', type: 'FLOAT', value: 41, unit: '°C' }],
      }),
    )
    expect(op.find((e) => e.key === 'maint-temperature')).toEqual({
      key: 'maint-temperature',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
      capabilities: ['temperature-sensor'],
      name: 'Operating temperature',
      unit: '°C',
      sourceParams: ['OPERATING_TEMPERATURE'],
    })

    const actual = mapMaintenanceChannel(
      hmDevice({
        maintenance: [{ parameter: 'ACTUAL_TEMPERATURE', type: 'FLOAT', value: 20, unit: '°C' }],
      }),
    )
    expect(actual.find((e) => e.key === 'maint-temperature')?.role).toBe(
      DeviceRole.TemperatureSensor,
    )
  })

  it('still emits an entity when the datapoint value is undefined (value arrives via push later)', () => {
    const device = hmDevice({
      maintenance: [
        // LOW_BAT marks this as a battery device (mains devices get no voltage entity).
        { parameter: 'LOW_BAT', type: 'BOOL', value: false },
        { parameter: 'OPERATING_VOLTAGE', type: 'FLOAT', value: null, unit: 'V' },
      ],
    })
    const entities = mapMaintenanceChannel(device)
    expect(entities.find((e) => e.key === 'maint-voltage')).toBeDefined()
  })

  it('does NOT emit a battery/voltage entity for a mains device (OPERATING_VOLTAGE but no LOW_BAT)', () => {
    const device = hmDevice({
      maintenance: [
        { parameter: 'OPERATING_VOLTAGE', type: 'FLOAT', value: 0, unit: 'V' },
        { parameter: 'RSSI_DEVICE', type: 'INTEGER', value: -60, unit: 'dBm' },
      ],
    })
    const entities = mapMaintenanceChannel(device)
    expect(entities.find((e) => e.key === 'maint-voltage')).toBeUndefined()
    expect(entities.find((e) => e.key === 'maint-battery-low')).toBeUndefined()
    // Non-battery diagnostics (RSSI) are still emitted.
    expect(entities.find((e) => e.key === 'maint-rssi-device')).toBeDefined()
  })

  it('skips reachability datapoints (UNREACH / STICKY_UNREACH / CONFIG_PENDING)', () => {
    const device = hmDevice({
      maintenance: [
        { parameter: 'UNREACH', type: 'BOOL', value: false },
        { parameter: 'STICKY_UNREACH', type: 'BOOL', value: false },
        { parameter: 'CONFIG_PENDING', type: 'BOOL', value: false },
      ],
    })
    expect(mapMaintenanceChannel(device)).toEqual([])
  })

  it('returns [] when there is no MAINTENANCE channel', () => {
    expect(mapMaintenanceChannel(hmDevice({ withoutMaintenanceChannel: true }))).toEqual([])
  })

  it('returns [] when MAINTENANCE has no recognised datapoints', () => {
    expect(
      mapMaintenanceChannel(hmDevice({ maintenance: [{ parameter: 'SOME_FUTURE_PARAM' }] })),
    ).toEqual([])
  })
})

describe('mapFirmwareUpdate', () => {
  it('returns the update entity when firmware fields are present', () => {
    const device = hmDevice({
      firmware: '1.2.0',
      availableFirmware: '1.4.0',
      updatable: true,
      firmwareUpdateState: 'UP_TO_DATE',
    })
    expect(mapFirmwareUpdate(device)).toEqual({
      key: 'update',
      deviceType: DeviceType.Update,
      role: null,
      capabilities: ['update'],
      name: 'Firmware',
    })
  })

  it('returns the update entity when only firmware is present', () => {
    expect(mapFirmwareUpdate(hmDevice({ firmware: '1.2.0' }))).not.toBeNull()
  })

  it('returns the update entity when updatable is true even without a firmware string', () => {
    expect(mapFirmwareUpdate(hmDevice({ updatable: true }))).not.toBeNull()
  })

  it('returns null when no firmware fields are present', () => {
    expect(mapFirmwareUpdate(hmDevice({}))).toBeNull()
  })

  it('returns null when updatable is false and there is no firmware', () => {
    expect(mapFirmwareUpdate(hmDevice({ updatable: false }))).toBeNull()
  })
})

describe('readReachability', () => {
  it('reads UNREACH true', () => {
    const device = hmDevice({ maintenance: [{ parameter: 'UNREACH', type: 'BOOL', value: true }] })
    expect(readReachability(device)).toEqual({ unreach: true })
  })

  it('reads UNREACH false', () => {
    const device = hmDevice({ maintenance: [{ parameter: 'UNREACH', type: 'BOOL', value: false }] })
    expect(readReachability(device)).toEqual({ unreach: false })
  })

  it('falls back to STICKY_UNREACH when UNREACH is absent', () => {
    const device = hmDevice({
      maintenance: [{ parameter: 'STICKY_UNREACH', type: 'BOOL', value: true }],
    })
    expect(readReachability(device)).toEqual({ unreach: true })
  })

  it('returns null when no reachability datapoint is present', () => {
    expect(
      readReachability(hmDevice({ maintenance: [{ parameter: 'LOW_BAT', value: false }] })),
    ).toBeNull()
  })

  it('returns null when there is no MAINTENANCE channel', () => {
    expect(readReachability(hmDevice({ withoutMaintenanceChannel: true }))).toBeNull()
  })
})
