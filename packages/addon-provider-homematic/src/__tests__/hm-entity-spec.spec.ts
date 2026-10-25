import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import type { HmCustomEntity, HmDevice } from 'nodehomematic'
import { deriveHmEntitySpecs } from '../devices/hm-entity-spec.js'

// ── Fixture builders (mirror hm-container-device.spec.ts) ────────────────────

const ADDR = '0001D3C99AB777'

interface DataPointSeed {
  parameter: string
  type?: string
  value?: boolean | number | string | null
  unit?: string
}

function dataPoint(seed: DataPointSeed) {
  return {
    id: `dp:${seed.parameter.toLowerCase()}`,
    parameter: seed.parameter,
    type: seed.type ?? 'FLOAT',
    value: seed.value ?? null,
    unit: seed.unit,
    readable: true,
    writable: false,
    hasEvents: true,
  }
}

/** Battery thermostat: HEATING channel + MAINTENANCE (OPERATING_VOLTAGE + RSSI +
 *  UNREACH) + firmware descriptor. */
function makeBatteryThermostat(): HmDevice {
  return {
    address: ADDR,
    type: 'HmIP-eTRV-C',
    name: 'Thermostat',
    firmware: '1.0.0',
    availableFirmware: '1.0.0',
    updatable: false,
    firmwareUpdateState: 'UP_TO_DATE',
    channels: [
      {
        address: `${ADDR}:1`,
        index: 1,
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        dataPoints: [],
      },
      {
        address: `${ADDR}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [
          dataPoint({ parameter: 'LOW_BAT', type: 'BOOL', value: false }),
          dataPoint({ parameter: 'OPERATING_VOLTAGE', value: 2.9, unit: 'V' }),
          dataPoint({ parameter: 'RSSI_DEVICE', type: 'INTEGER', value: -60, unit: 'dBm' }),
          dataPoint({ parameter: 'UNREACH', type: 'BOOL', value: false }),
        ],
      },
    ],
  } as unknown as HmDevice
}

/** Roller-shutter cover with one custom entity + an energy-meter channel. */
function makeCover(): HmDevice {
  return {
    address: ADDR,
    type: 'HmIP-BROLL',
    name: 'Roller',
    channels: [
      { address: `${ADDR}:4`, index: 4, type: 'SHUTTER_VIRTUAL_RECEIVER', dataPoints: [] },
      { address: `${ADDR}:7`, index: 7, type: 'ENERGIE_METER_TRANSMITTER', dataPoints: [] },
    ],
  } as unknown as HmDevice
}

/** Two-key wall switch (event-emitter) with no MAINTENANCE channel. */
function makeWallSwitch(): HmDevice {
  const dps = [{ parameter: 'PRESS_SHORT' }, { parameter: 'PRESS_LONG' }].map(dataPoint)
  return {
    address: ADDR,
    type: 'HmIP-WRC2',
    name: 'Wall switch',
    channels: [
      { address: `${ADDR}:1`, index: 1, type: 'KEY_TRANSCEIVER', dataPoints: dps },
      { address: `${ADDR}:2`, index: 2, type: 'KEY_TRANSCEIVER', dataPoints: dps },
    ],
  } as unknown as HmDevice
}

function climateEntity(): HmCustomEntity {
  return { kind: 'climate', device: ADDR, channel: `${ADDR}:1` } as unknown as HmCustomEntity
}

function coverEntity(): HmCustomEntity {
  return {
    kind: 'cover',
    device: ADDR,
    channel: `${ADDR}:4`,
    channels: [`${ADDR}:4`],
    statusChannels: [],
    travel: 'stable',
    currentPosition: null,
    isClosed: true,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deriveHmEntitySpecs', () => {
  it('battery thermostat → climate actuator + temp/humidity sensor + voltage/rssi diagnostics + update', () => {
    const specs = deriveHmEntitySpecs(makeBatteryThermostat(), [climateEntity()])
    const byKey = new Map(specs.map((s) => [s.key, s]))

    // Actuator (climate) from the custom entity.
    const act = byKey.get(`act-${ADDR}:1`)
    expect(act?.deviceType).toBe(DeviceType.Thermostat)
    expect(act?.capabilities).toEqual(['climate-control'])
    expect(act?.config['channel']).toBe(`${ADDR}:1`)
    expect(act?.config['kind']).toBe('climate')

    // Sensor child (temperature + humidity) from the HEATING channel.
    const sensor = byKey.get(`sensor-${ADDR}:1`)
    expect(sensor?.deviceType).toBe(DeviceType.Sensor)
    expect(sensor?.capabilities).toEqual(['temperature-sensor', 'humidity-sensor'])

    // Diagnostics from MAINTENANCE — voltage carries provenance + unit + role.
    const voltage = byKey.get('maint-voltage')
    expect(voltage?.deviceType).toBe(DeviceType.Sensor)
    expect(voltage?.role).toBe(DeviceRole.VoltageSensor)
    expect(voltage?.config['sourceParams']).toEqual(['OPERATING_VOLTAGE'])
    expect(voltage?.config['unit']).toBe('V')
    expect(byKey.has('maint-rssi-device')).toBe(true)

    // Firmware update.
    const update = byKey.get('update')
    expect(update?.deviceType).toBe(DeviceType.Update)
    expect(update?.capabilities).toEqual(['update'])

    // No event-emitter spec for a thermostat.
    expect(specs.some((s) => s.key === 'events')).toBe(false)
  })

  it('cover device → ONE cover actuator (entity channel) + ONE power-meter sensor; no diagnostics/update', () => {
    const specs = deriveHmEntitySpecs(makeCover(), [coverEntity()])
    const byKey = new Map(specs.map((s) => [s.key, s]))

    const act = byKey.get(`act-${ADDR}:4`)
    expect(act?.deviceType).toBe(DeviceType.Cover)
    expect(act?.capabilities).toEqual(['cover'])
    expect(act?.config['kind']).toBe('cover')
    // D869: a roller shutter is the cover KIND exporters read.
    expect(act?.role).toBe(DeviceRole.CoverShutter)

    const power = byKey.get(`sensor-${ADDR}:7`)
    expect(power?.capabilities).toEqual(['power-meter'])

    expect(specs.some((s) => s.key === 'update')).toBe(false)
    expect(specs.some((s) => s.key.startsWith('maint-'))).toBe(false)
  })

  it('wall switch key channels → exactly ONE event-emitter spec over the union vocabulary', () => {
    const specs = deriveHmEntitySpecs(makeWallSwitch(), [])
    const events = specs.filter((s) => s.deviceType === DeviceType.EventEmitter)
    expect(events).toHaveLength(1)
    expect(events[0]?.key).toBe('events')
    expect(events[0]?.capabilities).toEqual(['event-emitter'])
    expect(events[0]?.config['eventTypes']).toEqual(['PRESS_SHORT', 'PRESS_LONG'])
  })

  it('derives NO actuator spec when no custom entities are passed (preview/facade-less)', () => {
    // Same cover device, but with no custom entities → only the channel-derived
    // sensor + (none) diagnostics survive; the actuator needs a custom entity.
    const specs = deriveHmEntitySpecs(makeCover(), [])
    expect(specs.some((s) => s.key.startsWith('act-'))).toBe(false)
    expect(specs.some((s) => s.key === `sensor-${ADDR}:7`)).toBe(true)
  })

  it('config blob carries NO system/brokerId/integrationId/address (caller stamps those)', () => {
    const specs = deriveHmEntitySpecs(makeBatteryThermostat(), [climateEntity()])
    for (const spec of specs) {
      expect(spec.config['system']).toBeUndefined()
      expect(spec.config['brokerId']).toBeUndefined()
      expect(spec.config['integrationId']).toBeUndefined()
      expect(spec.config['address']).toBeUndefined()
    }
  })
})
