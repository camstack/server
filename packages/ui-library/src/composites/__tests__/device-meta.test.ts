import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import {
  DEVICE_TYPE_META,
  DEVICE_ROLE_META,
  deviceTypeMetaOf,
  deviceRoleMetaOf,
  allDeviceTypeFilterOptions,
} from '../device-meta'

/**
 * The `Record<DeviceType|DeviceRole, …>` maps already enforce exhaustiveness at
 * COMPILE time (a missing key fails the build). These runtime tests are a
 * second guard — they also catch an `as`-cast bypass and assert each entry is
 * well-formed (icon + non-empty label).
 */
describe('device-meta exhaustiveness', () => {
  it('maps every DeviceType to an icon + non-empty label', () => {
    for (const type of Object.values(DeviceType)) {
      const meta = DEVICE_TYPE_META[type]
      expect(meta, `missing meta for DeviceType.${type}`).toBeDefined()
      expect(meta.icon).toBeTruthy()
      expect(meta.labelFallback.length).toBeGreaterThan(0)
    }
  })

  it('maps every DeviceRole to an icon + non-empty label', () => {
    for (const role of Object.values(DeviceRole)) {
      const meta = DEVICE_ROLE_META[role]
      expect(meta, `missing meta for DeviceRole.${role}`).toBeDefined()
      expect(meta.icon).toBeTruthy()
      expect(meta.labelFallback.length).toBeGreaterThan(0)
    }
  })

  it('falls back to Generic / GenericSensor for unknown runtime strings', () => {
    expect(deviceTypeMetaOf('not-a-real-type').label).toBe('Generic')
    expect(deviceRoleMetaOf('not-a-real-role').label).toBe('Sensor')
  })

  it('falls back when a federated runtime enum is newer than the meta map', () => {
    const original = DEVICE_TYPE_META[DeviceType.PetFeeder]
    Reflect.deleteProperty(DEVICE_TYPE_META, DeviceType.PetFeeder)
    try {
      expect(deviceTypeMetaOf(DeviceType.PetFeeder).label).toBe('Generic')
    } finally {
      DEVICE_TYPE_META[DeviceType.PetFeeder] = original
    }
  })

  it('returns the exact meta for a known value via the string-safe lookup', () => {
    expect(deviceTypeMetaOf(DeviceType.Camera).label).toBe('Camera')
    expect(deviceRoleMetaOf(DeviceRole.TemperatureSensor).label).toBe('Temperature')
  })
})

describe('allDeviceTypeFilterOptions — exhaustive type-filter set', () => {
  const options = allDeviceTypeFilterOptions()

  it('returns exactly one option per DeviceType member', () => {
    expect(options.length).toBe(Object.values(DeviceType).length)
    const ids = options.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set<string>(Object.values(DeviceType)))
  })

  it('ids are the raw DeviceType strings (match the filtering predicate)', () => {
    for (const type of Object.values(DeviceType)) {
      const option = options.find((o) => o.id === type)
      expect(option, `missing option for DeviceType.${type}`).toBeDefined()
    }
  })

  it('each option carries the meta label + icon', () => {
    const byId = new Map(options.map((o) => [o.id, o]))
    for (const type of Object.values(DeviceType)) {
      const option = byId.get(type)
      expect(option, `missing option for DeviceType.${type}`).toBeDefined()
      expect(option?.label).toBe(DEVICE_TYPE_META[type].labelFallback)
      expect(option?.icon).toBe(DEVICE_TYPE_META[type].icon)
    }
  })

  it('includes recently-added types even with no matching items in a list', () => {
    const labels = options.map((o) => o.label)
    expect(labels).toContain('Vacuum')
    expect(labels).toContain('Lawn mower')
    expect(labels).toContain('Valve')
    expect(labels).toContain('Humidifier')
    expect(labels).toContain('Water heater')
    expect(labels).toContain('Weather')
    expect(labels).toContain('Image')
  })
})
