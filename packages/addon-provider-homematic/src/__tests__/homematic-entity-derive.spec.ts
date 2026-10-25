import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { HmDataPoint } from 'nodehomematic'
import { deriveHmEntityPreviews, type HmEntitySource } from '../homematic-entity-derive.js'

/** Build a full HmDataPoint from a minimal seed (no cast). */
function dp(parameter: string, type: string, unit?: string): HmDataPoint {
  return {
    id: `dp:${parameter.toLowerCase()}`,
    parameter,
    type,
    value: null,
    unit,
    readable: true,
    writable: false,
    hasEvents: true,
    min: undefined,
    max: undefined,
  }
}

/**
 * Fixtures are structurally compatible with `HmEntitySource` (a `Pick` over
 * `HmDevice`), so no cast is required. `dataPoints` is empty unless a test
 * reads a MAINTENANCE parameter.
 */

describe('deriveHmEntityPreviews', () => {
  it('derives one actuator preview for a switch device', () => {
    const dev: HmEntitySource = {
      channels: [
        { address: 'ABC0001:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
    }
    const previews = deriveHmEntityPreviews(dev)
    expect(previews).toHaveLength(1)
    expect(previews[0]).toEqual({
      key: 'act-ABC0001:3',
      type: DeviceType.Switch,
      name: 'switch ABC0001:3',
      capabilities: ['switch'],
    })
  })

  it('derives a sensor preview for a power-meter channel', () => {
    const dev: HmEntitySource = {
      channels: [
        { address: 'ABC0001:6', index: 6, type: 'ENERGIE_METER_TRANSMITTER', dataPoints: [] },
      ],
    }
    const previews = deriveHmEntityPreviews(dev)
    expect(previews).toHaveLength(1)
    expect(previews[0]?.key).toBe('sensor-ABC0001:6')
    expect(previews[0]?.type).toBe(DeviceType.Sensor)
    expect(previews[0]?.capabilities).toEqual(['power-meter'])
  })

  it('splits a thermostat channel into an actuator + a sensor preview', () => {
    const dev: HmEntitySource = {
      channels: [
        {
          address: 'ABC0002:1',
          index: 1,
          type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
          dataPoints: [],
        },
      ],
    }
    const previews = deriveHmEntityPreviews(dev)
    const act = previews.find((p) => p.key === 'act-ABC0002:1')
    const sensor = previews.find((p) => p.key === 'sensor-ABC0002:1')
    expect(act?.capabilities).toEqual(['climate-control'])
    expect(act?.type).toBe(DeviceType.Thermostat)
    expect(sensor?.capabilities).toEqual(['temperature-sensor', 'humidity-sensor'])
    expect(sensor?.type).toBe(DeviceType.Sensor)
  })

  it('collapses multiple key channels into one events preview', () => {
    const dev: HmEntitySource = {
      channels: [
        { address: 'ABC0003:1', index: 1, type: 'KEY_TRANSCEIVER', dataPoints: [] },
        { address: 'ABC0003:2', index: 2, type: 'KEY_TRANSCEIVER', dataPoints: [] },
      ],
    }
    const previews = deriveHmEntityPreviews(dev)
    const events = previews.filter((p) => p.key === 'events')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe(DeviceType.EventEmitter)
    expect(events[0]?.capabilities).toEqual(['event-emitter'])
  })

  it('derives diagnostic previews from the MAINTENANCE channel', () => {
    const dev: HmEntitySource = {
      channels: [
        { address: 'ABC0004:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
        {
          address: 'ABC0004:0',
          index: 0,
          type: 'MAINTENANCE',
          dataPoints: [
            dp('LOW_BAT', 'BOOL'),
            dp('OPERATING_VOLTAGE', 'FLOAT', 'V'),
            dp('RSSI_DEVICE', 'INTEGER', 'dBm'),
          ],
        },
      ],
    }
    const previews = deriveHmEntityPreviews(dev)
    expect(previews.find((p) => p.key === 'maint-voltage')?.type).toBe(DeviceType.Sensor)
    expect(previews.find((p) => p.key === 'maint-rssi-device')?.capabilities).toEqual([
      'numeric-sensor',
    ])
  })

  it('derives a firmware update preview when a firmware descriptor is present', () => {
    const dev: HmEntitySource = {
      channels: [
        { address: 'ABC0005:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
      firmware: '1.0.0',
      updatable: true,
    }
    const previews = deriveHmEntityPreviews(dev)
    const update = previews.find((p) => p.key === 'update')
    expect(update?.type).toBe(DeviceType.Update)
    expect(update?.capabilities).toEqual(['update'])
  })

  it('returns no update preview when there is no firmware descriptor', () => {
    const dev: HmEntitySource = {
      channels: [
        { address: 'ABC0006:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
    }
    const previews = deriveHmEntityPreviews(dev)
    expect(previews.some((p) => p.key === 'update')).toBe(false)
  })

  it('returns an empty list for a device with no supported channels', () => {
    const dev: HmEntitySource = {
      channels: [{ address: 'ABC0099:1', index: 1, type: 'SWITCH_TRANSMITTER', dataPoints: [] }],
    }
    expect(deriveHmEntityPreviews(dev)).toEqual([])
  })
})
