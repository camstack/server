/**
 * The composition contract (D659). The wire shape already carries every
 * variant a later slice implements, so slices 2–4 extend it without
 * reshaping it. The validator refuses those variants by name; the SCHEMA
 * accepts them.
 */
import { describe, expect, it } from 'vitest'
import { DeviceRole, DeviceType } from '../../device/device-type.js'
import {
  COMPOSER_ADDON_ID,
  CompositionSchema,
  composedDeviceRef,
  composedDeviceStableId,
  compositionReadKey,
  compositionSliceKey,
  compositionSourceKey,
  fieldReads,
} from '../composition.js'
import {
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '../examples.js'

const SENSOR = { addonId: 'provider-homeassistant', stableId: 'sensor.living_room_temperature' }

function room() {
  return roomCompositionExample({
    temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
    motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
    occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
  })
}

describe('the room example', () => {
  it('parses, and names temperature and occupancy fields', () => {
    const composition = room()
    // The role pins the device hero to the temperature readout; without it the
    // hero has no primary cap and stays on "Awaiting state…".
    expect(composition.target).toEqual({
      kind: 'new',
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
    expect(composition.features.map((f) => f.cap)).toEqual(['temperature-sensor', 'binary'])
    const temperature = composition.features[0]
    expect(temperature?.kind === 'fields' ? Object.keys(temperature.fields) : []).toEqual([
      'celsius',
      'lastFetchedAt',
    ])
  })

  it('reads every source by (addonId, stableId), never by numeric id', () => {
    const composition = room()
    const reads = composition.features.flatMap((f) =>
      f.kind === 'fields' ? Object.values(f.fields).flatMap(fieldReads) : [],
    )
    expect(reads).toHaveLength(3 + 3 + 2 + 2)
    for (const read of reads) {
      expect(read.source.addonId.length).toBeGreaterThan(0)
      expect(read.source.stableId.length).toBeGreaterThan(0)
    }
  })
})

describe('keys', () => {
  it('composes source, slice and read keys', () => {
    expect(compositionSourceKey(SENSOR)).toBe(
      'provider-homeassistant/sensor.living_room_temperature',
    )
    expect(compositionSliceKey(SENSOR, 'temperature-sensor')).toBe(
      'provider-homeassistant/sensor.living_room_temperature#temperature-sensor',
    )
    expect(
      compositionReadKey({ source: SENSOR, cap: 'temperature-sensor', fieldPath: 'celsius' }),
    ).toBe('provider-homeassistant/sensor.living_room_temperature#temperature-sensor.celsius')
  })

  it('mints the composed device identity from the block id', () => {
    expect(composedDeviceStableId('b1')).toBe('composed-b1')
    expect(composedDeviceRef('b1')).toEqual({ addonId: COMPOSER_ADDON_ID, stableId: 'composed-b1' })
  })
})

describe('the schema refuses what no slice will ever accept', () => {
  it('refuses a capability composed twice, naming it', () => {
    const result = CompositionSchema.safeParse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [
        { kind: 'fields', cap: 'binary', fields: {} },
        { kind: 'fields', cap: 'binary', fields: {} },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('`binary` is composed twice')
  })

  it('refuses an expression that references an unbound identifier', () => {
    const result = CompositionSchema.safeParse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [
        {
          kind: 'fields',
          cap: 'binary',
          fields: { on: { kind: 'expression', expr: 'a || b', bindings: {} } },
        },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain("unbound identifier 'a'")
  })
})

describe('the schema ACCEPTS the reserved variants (the validator refuses them by name)', () => {
  it('existing target, passthrough, commands and code all parse', () => {
    const parsed = CompositionSchema.parse({
      target: { kind: 'existing', device: SENSOR },
      features: [
        { kind: 'passthrough', cap: 'snapshot', source: SENSOR },
        {
          kind: 'fields',
          cap: 'switch',
          fields: { on: { kind: 'code', code: 'return true' } },
          commands: {
            turnOn: { kind: 'forward', source: SENSOR, cap: 'switch', method: 'turnOn' },
          },
        },
      ],
    })
    expect(parsed.target.kind).toBe('existing')
  })
})
