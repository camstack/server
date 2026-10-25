import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import { mapHmChannel, mapHmDeviceChannels, inferHmDeviceType } from '../homematic-mapping.js'

describe('mapHmChannel', () => {
  it('maps SWITCH_VIRTUAL_RECEIVER (HmIP-BSM/BS2) to a Switch with the switch cap', () => {
    const mapping = mapHmChannel('SWITCH_VIRTUAL_RECEIVER')
    expect(mapping).toEqual({
      deviceType: DeviceType.Switch,
      role: null,
      capabilities: ['switch'],
    })
  })

  it('maps SHUTTER_VIRTUAL_RECEIVER (HmIP-BROLL) to a Cover with the cover cap', () => {
    const mapping = mapHmChannel('SHUTTER_VIRTUAL_RECEIVER')
    expect(mapping?.deviceType).toBe(DeviceType.Cover)
    expect(mapping?.capabilities).toEqual(['cover'])
  })

  it('maps HEATING_CLIMATECONTROL_TRANSCEIVER to a Thermostat with climate + sensor caps', () => {
    const mapping = mapHmChannel('HEATING_CLIMATECONTROL_TRANSCEIVER')
    expect(mapping?.deviceType).toBe(DeviceType.Thermostat)
    expect(mapping?.capabilities).toEqual([
      'climate-control',
      'temperature-sensor',
      'humidity-sensor',
    ])
  })

  it('maps MOTIONDETECTOR_TRANSCEIVER (HmIP-SMI) to a motion Sensor with light cap', () => {
    const mapping = mapHmChannel('MOTIONDETECTOR_TRANSCEIVER')
    expect(mapping?.deviceType).toBe(DeviceType.Sensor)
    expect(mapping?.role).toBe(DeviceRole.MotionSensor)
    expect(mapping?.capabilities).toEqual(['motion', 'ambient-light-sensor'])
  })

  it('maps DOOR_LOCK_STATE_TRANSMITTER (HmIP-DLD) to a Lock with the lock-control cap', () => {
    const mapping = mapHmChannel('DOOR_LOCK_STATE_TRANSMITTER')
    expect(mapping?.deviceType).toBe(DeviceType.Lock)
    expect(mapping?.capabilities).toEqual(['lock-control'])
  })

  it('maps ENERGIE_METER_TRANSMITTER (HmIP-BSM/ESI) to a power Sensor with power-meter cap', () => {
    const mapping = mapHmChannel('ENERGIE_METER_TRANSMITTER')
    expect(mapping?.deviceType).toBe(DeviceType.Sensor)
    expect(mapping?.role).toBe(DeviceRole.PowerSensor)
    expect(mapping?.capabilities).toEqual(['power-meter'])
  })

  it('maps a KEY_TRANSCEIVER key channel to an EventEmitter with the event-emitter cap', () => {
    const mapping = mapHmChannel('KEY_TRANSCEIVER')
    expect(mapping).toEqual({
      deviceType: DeviceType.EventEmitter,
      role: null,
      capabilities: ['event-emitter'],
    })
  })

  it('maps every key channel TYPE variant to EventEmitter + event-emitter', () => {
    for (const type of ['KEY_TRANSCEIVER', 'KEY_TRANSMITTER', 'VIRTUAL_KEY', 'KEY']) {
      const mapping = mapHmChannel(type)
      expect(mapping?.deviceType).toBe(DeviceType.EventEmitter)
      expect(mapping?.capabilities).toEqual(['event-emitter'])
    }
  })

  it('is case-insensitive on the channel type', () => {
    expect(mapHmChannel('switch_virtual_receiver')).toEqual(mapHmChannel('SWITCH_VIRTUAL_RECEIVER'))
  })

  it('returns null for status-only mirrors, week profiles and maintenance', () => {
    expect(mapHmChannel('SWITCH_TRANSMITTER')).toBeNull()
    expect(mapHmChannel('SHUTTER_TRANSMITTER')).toBeNull()
    expect(mapHmChannel('HEATING_CLIMATECONTROL_RECEIVER_WEEK_PROFILE')).toBeNull()
    expect(mapHmChannel('MAINTENANCE')).toBeNull()
    expect(mapHmChannel('SOME_FUTURE_TYPE')).toBeNull()
    expect(mapHmChannel(undefined)).toBeNull()
  })
})

describe('mapHmDeviceChannels', () => {
  it('keeps only the channels with a supported mapping', () => {
    const device = {
      channels: [
        { address: 'ABC:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'ABC:3', index: 3, type: 'SWITCH_TRANSMITTER', dataPoints: [] },
        { address: 'ABC:4', index: 4, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
    }
    const mapped = mapHmDeviceChannels(device)
    expect(mapped).toHaveLength(1)
    expect(mapped[0]?.channel.address).toBe('ABC:4')
    expect(mapped[0]?.mapping.deviceType).toBe(DeviceType.Switch)
  })
})

describe('inferHmDeviceType', () => {
  it('prefers the switch actuator over the energy-meter sensor (HmIP-BSM)', () => {
    const device = {
      channels: [
        { address: 'BSM:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'BSM:4', index: 4, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
        { address: 'BSM:6', index: 6, type: 'ENERGIE_METER_TRANSMITTER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.Switch)
  })

  it('returns a Cover for an HmIP-BROLL roller shutter', () => {
    const device = {
      channels: [
        { address: 'BROLL:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'BROLL:3', index: 3, type: 'SHUTTER_TRANSMITTER', dataPoints: [] },
        { address: 'BROLL:4', index: 4, type: 'SHUTTER_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.Cover)
  })

  it('returns a Thermostat for a climate device (wins over its sensor caps)', () => {
    const device = {
      channels: [
        { address: 'WTH:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'WTH:1', index: 1, type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.Thermostat)
  })

  it('returns a Lock for an HmIP-DLD', () => {
    const device = {
      channels: [
        { address: 'DLD:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'DLD:1', index: 1, type: 'DOOR_LOCK_STATE_TRANSMITTER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.Lock)
  })

  it('returns a Sensor for a standalone HmIP-SMI motion detector', () => {
    const device = {
      channels: [
        { address: 'SMI:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'SMI:3', index: 3, type: 'MOTIONDETECTOR_TRANSCEIVER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.Sensor)
  })

  it('returns EventEmitter for a key-only remote (key channel wins over maintenance)', () => {
    const device = {
      channels: [
        { address: 'WRC2:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'WRC2:1', index: 1, type: 'KEY_TRANSCEIVER', dataPoints: [] },
        { address: 'WRC2:2', index: 2, type: 'KEY_TRANSCEIVER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.EventEmitter)
  })

  it('ranks EventEmitter above a remote battery / sensor channel', () => {
    // A remote whose key channels coexist with a sensor channel must still
    // report as an EventEmitter (the remote is primarily an event source).
    const device = {
      channels: [
        { address: 'RC:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'RC:1', index: 1, type: 'KEY_TRANSCEIVER', dataPoints: [] },
        { address: 'RC:6', index: 6, type: 'ENERGIE_METER_TRANSMITTER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.EventEmitter)
  })

  it('returns Generic when no channel maps (purely virtual device)', () => {
    const device = {
      channels: [
        { address: 'RCV:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
        { address: 'RCV:1', index: 1, type: 'SWITCH_TRANSMITTER', dataPoints: [] },
      ],
    }
    expect(inferHmDeviceType(device)).toBe(DeviceType.Generic)
  })
})
