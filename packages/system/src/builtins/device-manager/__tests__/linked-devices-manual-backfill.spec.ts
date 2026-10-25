import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { LinkCandidate } from '../device-linked-devices.js'
import { planManualBackfill } from '../linked-devices-manual-backfill.js'

/**
 * D356 retires the `auto` link mode. A camera that never chose `manual` was
 * linked by location until today, and a rule an operator relied on cannot
 * vanish on an update: what auto resolved is written ONCE into the manual
 * list, so the operator prunes from the picker instead of discovering an
 * absence. A camera already on `manual` is left exactly as it is.
 */
const CAM = 104
const candidates: readonly LinkCandidate[] = [
  { id: CAM, stableId: 'cam', parentDeviceId: null, location: 'Hall', type: DeviceType.Camera },
  // Device-tree child: always linked, never part of the manual list.
  { id: 1, stableId: 'c1', parentDeviceId: CAM, location: 'Hall', type: DeviceType.Sensor },
  // Same location, standalone → materialised.
  { id: 2, stableId: 'c2', parentDeviceId: null, location: 'Hall', type: DeviceType.Switch },
  // Same location, inside a container → the container's PRIMARY child.
  { id: 3513, stableId: 'k', parentDeviceId: null, location: 'Hall', type: DeviceType.Container },
  {
    id: 3519,
    stableId: 'f1',
    parentDeviceId: 3513,
    location: 'Hall',
    type: DeviceType.Switch,
    name: 'Faretti hall 1',
  },
  {
    id: 3520,
    stableId: 'f2',
    parentDeviceId: 3513,
    location: 'Hall',
    type: DeviceType.Switch,
    name: 'Faretti hall 2',
  },
  // Elsewhere → not linked.
  { id: 9, stableId: 'c9', parentDeviceId: null, location: 'Kitchen', type: DeviceType.Switch },
]

describe('planManualBackfill', () => {
  it('materialises what auto resolved, minus the device-tree children, into the manual list', () => {
    const plan = planManualBackfill({
      selfId: CAM,
      selfLocation: 'Hall',
      blob: {},
      candidates,
    })
    expect(plan).toEqual({ write: true, manualIds: [2, 3519] })
  })

  it('keeps an explicit manual pick and adds nothing to it', () => {
    const plan = planManualBackfill({
      selfId: CAM,
      selfLocation: 'Hall',
      blob: { _linkedDevicesMode: 'manual', _linkedDeviceIds: [9] },
      candidates,
    })
    expect(plan).toEqual({ write: false, manualIds: [9] })
  })

  it('unions a stale manual list with the auto set when the camera was still on auto', () => {
    const plan = planManualBackfill({
      selfId: CAM,
      selfLocation: 'Hall',
      blob: { _linkedDevicesMode: 'auto', _linkedDeviceIds: ['9'] },
      candidates,
    })
    expect(plan).toEqual({ write: true, manualIds: [9, 2, 3519] })
  })

  it('a camera with no location was linking nothing — it becomes manual with an empty list', () => {
    const plan = planManualBackfill({ selfId: CAM, selfLocation: null, blob: {}, candidates })
    expect(plan).toEqual({ write: true, manualIds: [] })
  })
})
