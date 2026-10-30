import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { HmDataPoint } from 'nodehomematic'
import {
  buildCcuGatewayCandidate,
  buildHmCandidates,
  deviceNativeId,
  entityNativeId,
  gatewayNativeId,
  parseNativeId,
} from '../homematic-discovery.js'

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
 * Minimal device fixtures — structurally compatible with `HmDiscoverable`
 * (a `Pick<HmDevice,...>`) so no cast is required. `index` and `dataPoints`
 * are required by `HmChannel`; `dataPoints` is left empty for clarity since
 * the discovery mapper only reads `channel.type`.
 */
const switchDev = {
  address: 'ABC0001',
  type: 'HmIP-BSM',
  name: 'Lampada hall',
  channels: [{ address: 'ABC0001:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] }],
}

const thermoDev = {
  address: 'ABC0002',
  type: 'HmIP-WTH-2',
  name: 'Termostato',
  channels: [
    {
      address: 'ABC0002:1',
      index: 1,
      type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
      dataPoints: [],
    },
  ],
}

/** A key/remote device (now an EventEmitter, not Generic). */
const remoteDev = {
  address: 'ABC0003',
  type: 'HmIP-RC8',
  name: 'Telecomando',
  channels: [
    { address: 'ABC0003:1', index: 1, type: 'KEY_TRANSCEIVER', dataPoints: [] },
    { address: 'ABC0003:2', index: 2, type: 'KEY_TRANSCEIVER', dataPoints: [] },
  ],
}

/** A purely status-only device that maps to nothing supported. */
const genericDev = {
  address: 'ABC0099',
  type: 'HmIP-XYZ',
  name: 'Sconosciuto',
  channels: [{ address: 'ABC0099:1', index: 1, type: 'SWITCH_TRANSMITTER', dataPoints: [] }],
}

describe('buildHmCandidates', () => {
  it('maps a switch device to one Switch candidate with the switch cap', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [switchDev],
      adopted: new Map(),
    })
    expect(cands).toHaveLength(1)
    const [first] = cands
    expect(first?.childNativeId).toBe('hm_001:device:ABC0001')
    expect(first?.type).toBe(DeviceType.Switch)
    expect(first?.name).toBe('Lampada hall')
    expect(first?.capabilities).toContain('switch')
    expect(first?.alreadyAdopted).toBe(false)
    expect(first?.adoptedDeviceId).toBeNull()
    expect(first?.status).toBe('online')
  })

  it('maps a thermostat device with climate + sensor caps', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [thermoDev],
      adopted: new Map(),
    })
    const [first] = cands
    expect(first?.type).toBe(DeviceType.Thermostat)
    expect(first?.capabilities).toEqual(
      expect.arrayContaining(['climate-control', 'temperature-sensor', 'humidity-sensor']),
    )
  })

  it('maps a key/remote device to one EventEmitter candidate with the event-emitter cap', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [remoteDev],
      adopted: new Map(),
    })
    expect(cands).toHaveLength(1)
    const [first] = cands
    expect(first?.childNativeId).toBe('hm_001:device:ABC0003')
    expect(first?.type).toBe(DeviceType.EventEmitter)
    // Multi-key remote: the event-emitter cap is deduped to a single entry.
    expect(first?.capabilities).toEqual(['event-emitter'])
  })

  it('omits devices that map to Generic (no supported channel)', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [genericDev],
      adopted: new Map(),
    })
    expect(cands).toHaveLength(0)
  })

  it('reflects already-adopted state from the adopted map (native id → deviceId)', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [switchDev],
      adopted: new Map([['hm_001:device:ABC0001', 42]]),
    })
    const [first] = cands
    expect(first?.alreadyAdopted).toBe(true)
    expect(first?.adoptedDeviceId).toBe(42)
  })

  it('falls back to the address as name when name is absent', () => {
    const noName = {
      address: 'ABC0004',
      type: 'HmIP-BSM',
      channels: [
        { address: 'ABC0004:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
    }
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [noName],
      adopted: new Map(),
    })
    const [first] = cands
    expect(first?.name).toBe('ABC0004')
  })

  it('surfaces the first CCU room as metadata.externalLocation', () => {
    const withRoom = {
      address: 'ABC0005',
      type: 'HmIP-BSM',
      name: 'Lampada hall',
      rooms: ['Hall'],
      channels: [
        { address: 'ABC0005:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      ],
    }
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [withRoom],
      adopted: new Map(),
    })
    const [first] = cands
    expect(first?.metadata.externalLocation).toBe('Hall')
  })

  it('omits metadata.externalLocation when the device has no rooms', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [switchDev],
      adopted: new Map(),
    })
    const [first] = cands
    expect(first?.metadata.externalLocation).toBeUndefined()
  })
})

describe('buildHmCandidates — per-entity children preview', () => {
  /**
   * A device with a functional SWITCH channel, an ENERGY-meter sensor channel,
   * a MAINTENANCE channel exposing operating voltage + device RSSI, and a
   * firmware descriptor — exercises actuator + sensor + diagnostics + update
   * preview derivation.
   */
  const richDev = {
    address: 'ABC0200',
    type: 'HmIP-BSM',
    name: 'Hall BSM',
    firmware: '1.2.0',
    updatable: true,
    channels: [
      { address: 'ABC0200:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', dataPoints: [] },
      { address: 'ABC0200:6', index: 6, type: 'ENERGIE_METER_TRANSMITTER', dataPoints: [] },
      {
        address: 'ABC0200:0',
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

  it('populates children[] with actuator, sensor, diagnostic and update previews', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [richDev],
      adopted: new Map(),
    })
    const [first] = cands
    expect(first).toBeDefined()
    const children = first?.children ?? []
    const byKey = new Map(children.map((c) => [c.childNativeId, c]))

    // Actuator (switch) — preview only.
    const act = byKey.get('hm_001:entity:ABC0200#act-ABC0200:3')
    expect(act).toBeDefined()
    expect(act?.type).toBe(DeviceType.Switch)
    expect(act?.capabilities).toEqual(['switch'])

    // Sensor (power meter).
    const sensor = byKey.get('hm_001:entity:ABC0200#sensor-ABC0200:6')
    expect(sensor).toBeDefined()
    expect(sensor?.type).toBe(DeviceType.Sensor)
    expect(sensor?.capabilities).toEqual(['power-meter'])

    // Diagnostics from MAINTENANCE.
    expect(byKey.get('hm_001:entity:ABC0200#maint-voltage')).toBeDefined()
    expect(byKey.get('hm_001:entity:ABC0200#maint-rssi-device')).toBeDefined()

    // Firmware update.
    const update = byKey.get('hm_001:entity:ABC0200#update')
    expect(update).toBeDefined()
    expect(update?.type).toBe(DeviceType.Update)
    expect(update?.capabilities).toEqual(['update'])
  })

  it('marks every preview child not-yet-adopted (entity-level adoption is a separate task)', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [richDev],
      adopted: new Map(),
    })
    const children = cands[0]?.children ?? []
    expect(children.length).toBeGreaterThan(0)
    expect(children.every((c) => c.alreadyAdopted === false)).toBe(true)
    expect(children.every((c) => c.adoptedDeviceId === null)).toBe(true)
    expect(children.every((c) => c.status === 'online')).toBe(true)
  })

  it('emits a single events preview for a multi-key remote', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [remoteDev],
      adopted: new Map(),
    })
    const children = cands[0]?.children ?? []
    const eventChildren = children.filter((c) => c.childNativeId === 'hm_001:entity:ABC0003#events')
    expect(eventChildren).toHaveLength(1)
    expect(eventChildren[0]?.type).toBe(DeviceType.EventEmitter)
    expect(eventChildren[0]?.capabilities).toEqual(['event-emitter'])
  })

  it('emits no children for a switch with no maintenance/firmware/sensor channels (only the actuator)', () => {
    const cands = buildHmCandidates({
      integrationId: 'hm_001',
      devices: [switchDev],
      adopted: new Map(),
    })
    const children = cands[0]?.children ?? []
    expect(children).toHaveLength(1)
    expect(children[0]?.childNativeId).toBe('hm_001:entity:ABC0001#act-ABC0001:3')
  })
})

describe('native ids are namespaced under the integration', () => {
  it('two CCUs exposing the same address never collide', () => {
    const a = buildHmCandidates({
      integrationId: 'int-a',
      devices: [switchDev],
      adopted: new Map(),
    })
    const b = buildHmCandidates({
      integrationId: 'int-b',
      devices: [switchDev],
      adopted: new Map(),
    })
    expect(a[0]?.childNativeId).toBe('int-a:device:ABC0001')
    expect(b[0]?.childNativeId).toBe('int-b:device:ABC0001')
    // A device adopted from CCU A does not mark CCU B's same-address device adopted.
    const mixed = buildHmCandidates({
      integrationId: 'int-b',
      devices: [switchDev],
      adopted: new Map([['int-a:device:ABC0001', 7]]),
    })
    expect(mixed[0]?.alreadyAdopted).toBe(false)
  })

  it('parseNativeId round-trips the gateway, device and entity ids and refuses foreign or malformed ones', () => {
    expect(parseNativeId('int-a', gatewayNativeId('int-a'))).toEqual({ kind: 'gateway' })
    expect(parseNativeId('int-a', deviceNativeId('int-a', 'ABC1'))).toEqual({
      kind: 'device',
      hmAddress: 'ABC1',
    })
    expect(parseNativeId('int-a', entityNativeId('int-a', 'ABC1', 'act-ABC1:3'))).toEqual({
      kind: 'entity',
      hmAddress: 'ABC1',
      key: 'act-ABC1:3',
    })
    expect(parseNativeId('int-a', deviceNativeId('int-b', 'ABC1'))).toBeNull()
    expect(parseNativeId('int-a', 'int-a:device:')).toBeNull()
    expect(parseNativeId('int-a', 'int-a:entity:ABC1#')).toBeNull()
    expect(parseNativeId('int-a', 'int-a:entity:#key')).toBeNull()
    expect(parseNativeId('int-a', 'ABC1')).toBeNull()
  })
})

describe('buildCcuGatewayCandidate', () => {
  it('is one Gateway candidate that offers only the WebUI link', () => {
    const c = buildCcuGatewayCandidate({
      integrationId: 'int-a',
      integrationName: 'Casa CCU',
      online: true,
      adopted: new Map(),
    })
    expect(c.childNativeId).toBe('int-a:gateway')
    expect(c.type).toBe(DeviceType.Gateway)
    expect(c.name).toBe('Casa CCU')
    expect(c.status).toBe('online')
    expect(c.capabilities).toEqual(['device-admin-link'])
    expect(c.capabilities).not.toContain('reboot')
    expect(c.capabilities).not.toContain('update')
    expect(c.alreadyAdopted).toBe(false)
  })

  it('reports offline and already-adopted from the live session and the adopted map', () => {
    const c = buildCcuGatewayCandidate({
      integrationId: 'int-a',
      integrationName: 'Casa CCU',
      online: false,
      adopted: new Map([['int-a:gateway', 9]]),
    })
    expect(c.status).toBe('offline')
    expect(c.alreadyAdopted).toBe(true)
    expect(c.adoptedDeviceId).toBe(9)
  })
})
