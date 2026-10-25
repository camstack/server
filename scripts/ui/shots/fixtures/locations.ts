/**
 * The Locations page (`/locations`): the room tabs, the room header with its
 * icon picker, and the zones. Two invented rooms, one with an icon chosen and
 * one without, so both states of the picker trigger are on screen.
 */
import { defineFixtures } from './_define'

const device = (id: number, name: string, location: string) => ({
  id,
  stableId: `dev-${id}`,
  addonId: 'provider-reolink',
  type: 'camera',
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: true,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const ROOM_NAMES = [
  'Kitchen',
  'Garage',
  'Hallway',
  'Living room',
  'Dining room',
  'Master bedroom',
  'Guest bedroom',
  'Kids room',
  'Bathroom',
  'Laundry',
  'Office',
  'Basement',
  'Attic',
  'Porch',
  'Front yard',
  'Back yard',
  'Driveway',
  'Terrace',
  'Pool',
  'Pool house',
  'Workshop',
  'Cellar',
  'Stairs',
  'Gym',
  'Library',
  'Studio',
  'Gate',
  'Shed',
]

/** 28 rooms with a camera each and a sensor in every other one: the room selector has to cope with many. */
const MANY_ROOMS = ROOM_NAMES.flatMap((room, i) => [
  device(1000 + i * 2, `${room} camera`, room),
  ...(i % 2 === 0
    ? [{ ...device(1001 + i * 2, `${room} sensor`, room), type: 'sensor', isCamera: false }]
    : []),
])

export default defineFixtures({
  area: 'locations',
  description:
    'Locations page: 28 rooms (one with an icon), cameras with linked devices, three site zones',
  handlers: {
    'deviceManager.listLocations': ROOM_NAMES,
    'deviceExtension.listSlots': (i: { deviceId: number }) => [
      {
        state: 'ok',
        slotRef: 'device-manager:linked-devices',
        slot: 'linked-devices',
        authority: 'device-manager:_linkedDeviceIds',
        activation: null,
        value: { slot: 'linked-devices', deviceIds: i.deviceId === 201 ? [1001] : [] },
        sources:
          i.deviceId === 201 ? [{ deviceId: 1001, name: 'Kitchen sensor', health: 'ok' }] : [],
      },
    ],
    'deviceExtension.listCandidates': {
      candidates: [
        {
          deviceId: 1001,
          name: 'Kitchen sensor',
          type: 'sensor',
          location: 'Kitchen',
          parentName: null,
          suggested: true,
          reason: 'same location',
        },
        {
          deviceId: 1003,
          name: 'Kitchen window',
          type: 'sensor',
          location: 'Kitchen',
          parentName: null,
          suggested: true,
          reason: 'same location',
        },
        {
          deviceId: 1005,
          name: 'Living room sensor',
          type: 'sensor',
          location: 'Living room',
          parentName: null,
          suggested: false,
          reason: null,
        },
        {
          deviceId: 1007,
          name: 'Dining room sensor',
          type: 'sensor',
          location: 'Dining room',
          parentName: null,
          suggested: false,
          reason: null,
        },
      ],
    },
    'deviceManager.listLocationIcons': [{ locationKey: 'kitchen', icon: 'utensils' }],
    'deviceManager.listLocationDescriptions': [],
    'deviceManager.listAll': [
      device(201, 'Counter', 'Kitchen'),
      device(202, 'Door', 'Garage'),
      ...MANY_ROOMS,
    ],
    'deviceManager.listSiteZones': [
      { zoneKey: 'night zone', label: 'Night zone', icon: 'bed-double', locationKeys: ['kitchen'] },
      {
        zoneKey: 'zona giorno',
        label: 'Zona giorno',
        icon: null,
        locationKeys: ['garage'],
      },
      { zoneKey: 'esterno', label: 'Esterno', icon: null, locationKeys: [] },
    ],
  },
})
