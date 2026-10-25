import { describe, it, expect } from 'vitest'
import { groupTopLevelAndAccessories, countableDevices, orderAdoptedAfterParent } from '../group'
import type { DeviceItemDevice } from '../../device-item/helpers'

const dev = (overrides: Partial<DeviceItemDevice> & { id: number }): DeviceItemDevice => ({
  id: overrides.id,
  stableId: `stable-${overrides.id}`,
  addonId: overrides.addonId ?? 'provider-test',
  type: overrides.type ?? 'camera',
  name: overrides.name ?? `Device ${overrides.id}`,
  online: overrides.online ?? true,
  disabled: overrides.disabled ?? false,
  parentDeviceId: overrides.parentDeviceId ?? null,
  role: overrides.role ?? null,
  features: overrides.features,
  display: overrides.display,
})

describe('groupTopLevelAndAccessories', () => {
  it('returns empty when input is empty', () => {
    const result = groupTopLevelAndAccessories([])
    expect(result.topLevel).toEqual([])
    expect(result.accessoriesByParent.size).toBe(0)
  })

  it('keeps top-level devices (parentDeviceId=null, role=null) as topLevel', () => {
    const a = dev({ id: 1, type: 'camera' })
    const b = dev({ id: 2, type: 'hub' })
    const result = groupTopLevelAndAccessories([a, b])
    expect(result.topLevel).toEqual([a, b])
    expect(result.accessoriesByParent.size).toBe(0)
  })

  it('treats role=null adopted children as top-level (cameras adopted under hub)', () => {
    const hub = dev({ id: 1, type: 'hub' })
    const cam = dev({ id: 2, type: 'camera', parentDeviceId: 1 })
    const result = groupTopLevelAndAccessories([hub, cam])
    expect(result.topLevel).toEqual([hub, cam])
    expect(result.accessoriesByParent.size).toBe(0)
  })

  it('groups accessories (role!=null) under their parent', () => {
    const cam = dev({ id: 1, type: 'camera' })
    const flood = dev({ id: 2, type: 'light', role: 'floodlight', parentDeviceId: 1 })
    const siren = dev({ id: 3, type: 'siren', role: 'siren', parentDeviceId: 1 })
    const result = groupTopLevelAndAccessories([cam, flood, siren])
    expect(result.topLevel).toEqual([cam])
    expect(result.accessoriesByParent.get(1)).toEqual([flood, siren])
  })

  it('keeps orphan accessories (parent missing) as top-level', () => {
    const orphan = dev({ id: 99, type: 'siren', role: 'siren', parentDeviceId: 42 })
    const result = groupTopLevelAndAccessories([orphan])
    expect(result.topLevel).toEqual([orphan])
    expect(result.accessoriesByParent.size).toBe(0)
  })

  it('excludes devices with display.hidden from both top-level and accessories by default', () => {
    const cam = dev({ id: 1, type: 'camera' })
    const hiddenTop = dev({ id: 2, type: 'camera', display: { hidden: true } })
    const flood = dev({ id: 3, type: 'light', role: 'floodlight', parentDeviceId: 1 })
    const hiddenAcc = dev({
      id: 4,
      type: 'siren',
      role: 'siren',
      parentDeviceId: 1,
      display: { hidden: true },
    })
    const result = groupTopLevelAndAccessories([cam, hiddenTop, flood, hiddenAcc])
    expect(result.topLevel).toEqual([cam])
    expect(result.accessoriesByParent.get(1)).toEqual([flood])
  })

  it('includes hidden devices when includeHidden:true', () => {
    const cam = dev({ id: 1, type: 'camera' })
    const hiddenTop = dev({ id: 2, type: 'camera', display: { hidden: true } })
    const result = groupTopLevelAndAccessories([cam, hiddenTop], { includeHidden: true })
    expect(result.topLevel).toEqual([cam, hiddenTop])
  })

  it('preserves input order in topLevel', () => {
    const a = dev({ id: 3, name: 'Alpha' })
    const b = dev({ id: 1, name: 'Bravo' })
    const c = dev({ id: 2, name: 'Charlie' })
    const result = groupTopLevelAndAccessories([a, b, c])
    expect(result.topLevel.map((d) => d.id)).toEqual([3, 1, 2])
  })
})

describe('countableDevices', () => {
  it('returns empty for empty input', () => {
    expect(countableDevices([])).toEqual([])
  })

  it('counts top-level devices (parentDeviceId=null)', () => {
    const cam = dev({ id: 1, type: 'camera' })
    const hub = dev({ id: 2, type: 'hub' })
    expect(countableDevices([cam, hub])).toEqual([cam, hub])
  })

  it('counts hub children but NOT container children', () => {
    // Container (id=1) with 2 entity-children → container counts as 1, children excluded
    // Hub (id=2) with 1 camera child → hub + camera both counted
    const container = dev({ id: 1, type: 'container' })
    const cover = dev({ id: 3, type: 'cover', parentDeviceId: 1 })
    const sensor = dev({ id: 4, type: 'sensor', parentDeviceId: 1 })
    const hub = dev({ id: 2, type: 'hub' })
    const cam = dev({ id: 5, type: 'camera', parentDeviceId: 2 })

    const result = countableDevices([container, cover, sensor, hub, cam])
    expect(result).toHaveLength(3)
    expect(result.map((d) => d.id)).toEqual([1, 2, 5])
  })

  it('counts nvr children (nvr is a hub-like owner)', () => {
    const nvr = dev({ id: 1, type: 'nvr' })
    const cam = dev({ id: 2, type: 'camera', parentDeviceId: 1 })
    const result = countableDevices([nvr, cam])
    expect(result).toHaveLength(2)
  })

  it('counts orphan devices (parent not in list) — safe default', () => {
    const orphan = dev({ id: 7, type: 'sensor', parentDeviceId: 999 })
    const result = countableDevices([orphan])
    expect(result).toEqual([orphan])
  })

  it('excludes children of container regardless of child type', () => {
    const container = dev({ id: 1, type: 'container' })
    const light = dev({ id: 2, type: 'light', parentDeviceId: 1 })
    const result = countableDevices([container, light])
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe(1)
  })
})

describe('orderAdoptedAfterParent (via groupTopLevelAndAccessories)', () => {
  it('moves adopted rows immediately after their parent, past a stranger wedged between', () => {
    // The operator's screenshot: Carol, Home hub, Baby monitor (standalone),
    // then the hub's two adopted cameras — family scattered by arrival order.
    const carol = dev({ id: 107, type: 'camera', name: 'Carol' })
    const hub = dev({ id: 639, type: 'hub', name: 'Home hub' })
    const baby = dev({ id: 106, type: 'camera', name: 'Baby monitor' })
    const laundry = dev({ id: 3628, type: 'camera', name: 'Laundry', parentDeviceId: 639 })
    const retro = dev({ id: 3629, type: 'camera', name: 'Porta retro', parentDeviceId: 639 })
    const result = groupTopLevelAndAccessories([carol, hub, baby, laundry, retro])
    expect(result.topLevel.map((d) => d.id)).toEqual([107, 639, 3628, 3629, 106])
  })

  it('keeps sibling order and never drops a child whose parent chain is odd', () => {
    // Direct unit: a self-referential row must be emitted (never dropped),
    // and siblings keep their incoming relative order after the parent.
    const selfRef = dev({ id: 7, type: 'camera', parentDeviceId: 7 })
    const hub = dev({ id: 1, type: 'hub' })
    const kidB = dev({ id: 3, type: 'camera', parentDeviceId: 1 })
    const kidA = dev({ id: 2, type: 'camera', parentDeviceId: 1 })
    const ordered = orderAdoptedAfterParent([selfRef, kidB, hub, kidA])
    expect(ordered.map((d) => d.id)).toEqual([7, 1, 3, 2])
  })
})
