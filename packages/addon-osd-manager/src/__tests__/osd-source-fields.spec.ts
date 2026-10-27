import { ALL_CAPABILITY_DEFINITIONS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { resolveAdaptiveFields } from '../adaptive-field.js'
import { osdSupportedChildrenOf, toOsdPickerDevices } from '../osd-picker-devices.js'
import {
  isContainerDeviceType,
  isOsdLeafDeviceType,
  isOsdSourceCap,
  osdStateLeavesOf,
} from '../osd-source-fields.js'
import { sourceOptionsFor } from '../source-catalog.js'
import { generateTemplateId, templateIdFromName } from '../template-id.js'

function cap(name: string) {
  const found = ALL_CAPABILITY_DEFINITIONS.find((c) => c.name === name)
  if (found === undefined) throw new Error(`missing cap ${name}`)
  return found
}

describe('osd source whitelist', () => {
  it('rejects broker / mqtt / export / probe caps', () => {
    for (const name of [
      'broker',
      'mqtt-broker',
      'device-export',
      'feature-probe',
      'device-status',
      'stream-broker',
      'motion',
    ]) {
      expect(isOsdSourceCap(name)).toBe(false)
      expect(osdStateLeavesOf(cap(name))).toEqual([])
    }
  })

  it('keeps sensor primary leaves and drops unit/precision metadata', () => {
    expect(osdStateLeavesOf(cap('temperature-sensor')).map((l) => l.path)).toEqual(['temperature'])
    expect(osdStateLeavesOf(cap('humidity-sensor')).map((l) => l.path)).toEqual(['humidity'])
    expect(osdStateLeavesOf(cap('numeric-sensor')).map((l) => l.path)).toEqual(['value'])
    expect(osdStateLeavesOf(cap('battery')).map((l) => l.path)).toEqual(['level'])
  })

  it('auto-selects when a device has a single OSD field', () => {
    const options = sourceOptionsFor(
      1,
      [{ id: 9, name: 'Thermo' }],
      new Map([[9, ['temperature-sensor']]]),
    )
    const decision = resolveAdaptiveFields(options, 9)
    expect(decision.mode).toBe('auto')
    expect(decision.auto?.valuePath).toBe('temperature')
  })
})

describe('container → child path', () => {
  it('lists containers in the DevicePicker but not as catalog leaves', () => {
    expect(isContainerDeviceType('container')).toBe(true)
    expect(isOsdLeafDeviceType('container')).toBe(false)
    expect(isOsdLeafDeviceType('sensor')).toBe(true)
    const devices = toOsdPickerDevices([
      { id: 1, name: 'Ecowitt Gateway', type: 'container', location: 'Roof' },
      { id: 2, name: 'Outdoor Temp', type: 'sensor', location: 'Roof', parentDeviceId: 1 },
      { id: 3, name: 'Outdoor Humidity', type: 'sensor', location: 'Roof', parentDeviceId: 1 },
    ])
    expect(devices.map((d) => d.id)).toEqual([1, 2, 3])
  })

  it('forces an OSD-supported child after a container pick', () => {
    const devices = toOsdPickerDevices([
      { id: 1, name: 'Ecowitt Gateway', type: 'container' },
      { id: 2, name: 'Outdoor Temp', type: 'sensor', parentDeviceId: 1 },
      { id: 3, name: 'Broker junk', type: 'sensor', parentDeviceId: 1 },
      { id: 4, name: 'Other', type: 'sensor', parentDeviceId: 99 },
    ])
    const withFields = new Set([2])
    expect(osdSupportedChildrenOf(1, devices, withFields).map((d) => d.id)).toEqual([2])
  })

  it('lists child sensor OSD fields, not gateway leaves', () => {
    const options = sourceOptionsFor(
      100,
      [
        { id: 1, name: 'Ecowitt Gateway', type: 'container' },
        { id: 2, name: 'Outdoor Temp', type: 'sensor' },
      ],
      new Map([
        [1, ['broker', 'mqtt-broker', 'device-export', 'feature-probe', 'battery']],
        [2, ['temperature-sensor']],
      ]),
    )
    expect(options.filter((o) => o.deviceId === 1)).toEqual([])
    expect(options.filter((o) => o.deviceId === 2).map((o) => o.valuePath)).toEqual(['temperature'])
  })
})

describe('template id generation', () => {
  it('generates a non-empty id without operator input', () => {
    const a = generateTemplateId()
    const b = generateTemplateId()
    expect(a.length).toBeGreaterThan(8)
    expect(b.length).toBeGreaterThan(8)
    expect(a).not.toBe(b)
  })

  it('can slug from name when that path is chosen', () => {
    const id = templateIdFromName(' Porch Sensors ')
    expect(id.startsWith('porch-sensors-')).toBe(true)
  })
})
