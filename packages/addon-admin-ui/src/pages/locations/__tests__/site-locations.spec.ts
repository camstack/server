import { describe, expect, it } from 'vitest'
import {
  cascadeFollowerCount,
  descendantsOf,
  devicesAtLocation,
  groupDevicesBySite,
  linkedChildren,
  topLevelAtLocation,
  topLevelUnassigned,
  unassignedDevices,
  unregisteredLocationOf,
  type SiteDevice,
} from '../site-locations'

function device(
  id: number,
  name: string,
  location: string | null,
  extra?: Partial<SiteDevice>,
): SiteDevice {
  return {
    id,
    name,
    location,
    type: extra?.type ?? (extra?.isCamera === false ? 'sensor' : 'camera'),
    isCamera: extra?.isCamera ?? true,
    parentDeviceId: extra?.parentDeviceId ?? null,
    online: extra?.online ?? true,
    role: extra?.role ?? null,
    ...extra,
  }
}

describe('site location grouping — every device, not cameras only', () => {
  const frontDoor = device(1, 'Front door cam', 'Front door')
  const hall = device(2, 'Hall cam', 'Hall')
  const kitchen = device(3, 'Kitchen cam', 'Kitchen')
  const unsetCam = device(4, 'Garage cam', null)
  const doorbell = device(11, 'Campanello', 'Front door', {
    isCamera: false,
    type: 'sensor',
    parentDeviceId: 1,
    role: 'doorbell',
  })
  const standaloneLock = device(20, 'Serratura front door', 'Front door', {
    isCamera: false,
    type: 'lock',
    parentDeviceId: null,
  })
  const unsetSensor = device(21, 'Termometro', null, {
    isCamera: false,
    type: 'sensor',
    parentDeviceId: null,
  })
  const nestedUnset = device(12, 'Sirena', null, {
    isCamera: false,
    type: 'siren',
    parentDeviceId: 1,
  })

  const fleet = [
    frontDoor,
    hall,
    kitchen,
    unsetCam,
    doorbell,
    standaloneLock,
    unsetSensor,
    nestedUnset,
  ]

  /** The rooms the registry actually knows. Everything else is a dead label. */
  const REGISTERED = ['Front door', 'Hall', 'Kitchen', 'Garden']

  it('lists every device in a room, including locks and sensors', () => {
    expect(
      devicesAtLocation(fleet, 'Front door')
        .map((d) => d.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 11, 20])
  })

  it('keeps linked accessories nested when the parent is in the same room', () => {
    const top = topLevelAtLocation(fleet, 'Front door')
    expect(top.map((d) => d.id).sort((a, b) => a - b)).toEqual([1, 20])
    expect(linkedChildren(fleet, 1).map((d) => d.name)).toEqual(['Campanello', 'Sirena'])
  })

  it('promotes an accessory to its own row when it lives in a different room than its parent', () => {
    const elsewhere = device(30, 'Sensore garden', 'Garden', {
      isCamera: false,
      type: 'sensor',
      parentDeviceId: 1,
    })
    expect(topLevelAtLocation([...fleet, elsewhere], 'Garden').map((d) => d.id)).toEqual([30])
  })

  it('groups members under their site label, keeping empty rooms', () => {
    const groups = groupDevicesBySite(fleet, ['Kitchen', 'Garden', 'Front door'])
    expect(groups.map((g) => g.name)).toEqual(['Kitchen', 'Garden', 'Front door'])
    expect(groups.find((g) => g.name === 'Garden')?.members).toEqual([])
    expect(
      groups
        .find((g) => g.name === 'Front door')
        ?.members.map((d) => d.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 20])
  })

  it('unassigned is every device with no room, except accessories already nested under an assigned parent', () => {
    expect(
      unassignedDevices(fleet, REGISTERED)
        .map((d) => d.id)
        .sort((a, b) => a - b),
    ).toEqual([4, 21])
  })

  it('matches location labels case-insensitively', () => {
    expect(devicesAtLocation(fleet, 'front door').map((d) => d.id)).toContain(1)
  })
})

/**
 * The unassigned TABLE: what gets a row, and what the row promises.
 *
 * Two failures this pins:
 *   - a device labelled with a room the registry never heard of used to be in
 *     no card AND in no unassigned list — it left the page entirely;
 *   - the "accessories in tow" count is what makes the cascade honest. It must
 *     count what the SERVER moves (every descendant, any type, any depth), not
 *     what `linkedChildren` shows (direct, non-camera children only) and not
 *     what a search filter happens to leave on screen.
 */
describe('unassigned table — rows and the cascade they promise', () => {
  const REGISTERED = ['Hall']

  const cam = device(1, 'Camera Hall', null, { type: 'camera' })
  const siren = device(2, 'Sirena', null, {
    isCamera: false,
    type: 'siren',
    parentDeviceId: 1,
  })
  const sirenSwitch = device(3, 'Sirena switch', null, {
    isCamera: false,
    type: 'switch',
    parentDeviceId: 2,
  })
  const childCam = device(4, 'Camera figlia', null, { type: 'camera', parentDeviceId: 1 })
  const lonelyLock = device(5, 'Serratura', null, { isCamera: false, type: 'lock' })
  const assignedCam = device(6, 'Camera assegnata', 'Hall', { type: 'camera' })
  const assignedChild = device(7, 'Sensore assegnato', null, {
    isCamera: false,
    type: 'sensor',
    parentDeviceId: 6,
  })
  const ghostRoomCam = device(8, 'Camera stanza fantasma', 'Mansarda', { type: 'camera' })

  const fleet = [
    cam,
    siren,
    sirenSwitch,
    childCam,
    lonelyLock,
    assignedCam,
    assignedChild,
    ghostRoomCam,
  ]

  it('gives a row ONLY to top-level roomless devices — accessories follow their parent', () => {
    expect(
      topLevelUnassigned(fleet, REGISTERED)
        .map((d) => d.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 5, 8])
  })

  it('a device in a room the registry does not know counts as unassigned — it must not vanish', () => {
    expect(unassignedDevices(fleet, REGISTERED).map((d) => d.id)).toContain(ghostRoomCam.id)
    expect(unregisteredLocationOf(ghostRoomCam, REGISTERED)).toBe('Mansarda')
  })

  it('a device in a REGISTERED room is not unassigned, and neither is its nested accessory', () => {
    const ids = unassignedDevices(fleet, REGISTERED).map((d) => d.id)
    expect(ids).not.toContain(assignedCam.id)
    expect(ids).not.toContain(assignedChild.id)
    expect(unregisteredLocationOf(assignedCam, REGISTERED)).toBeNull()
  })

  it('registered-room matching stays case-insensitive', () => {
    expect(unassignedDevices(fleet, ['hall']).map((d) => d.id)).not.toContain(assignedCam.id)
  })

  it('accessories in tow = every descendant the server cascade rewrites, at any depth and any type', () => {
    // Direct child, grandchild, AND a child CAMERA — `linkedChildren` drops the
    // camera, the cascade does not.
    expect(
      descendantsOf(fleet, cam.id)
        .map((d) => d.id)
        .sort((a, b) => a - b),
    ).toEqual([2, 3, 4])
    expect(cascadeFollowerCount(fleet, cam.id)).toBe(3)
    expect(linkedChildren(fleet, cam.id).map((d) => d.id)).toEqual([2])
  })

  it('a device with no children promises nothing', () => {
    expect(cascadeFollowerCount(fleet, lonelyLock.id)).toBe(0)
  })

  it('a parent cycle in persisted data does not hang the count', () => {
    const a = device(90, 'A', null, { isCamera: false, type: 'sensor', parentDeviceId: 91 })
    const b = device(91, 'B', null, { isCamera: false, type: 'sensor', parentDeviceId: 90 })
    expect(cascadeFollowerCount([a, b], a.id)).toBe(1)
  })
})
