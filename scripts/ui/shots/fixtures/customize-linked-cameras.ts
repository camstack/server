/**
 * Customize tab of a device cameras link ("Linked to cameras"): the Porch light
 * (303) in a fleet of twelve cameras, two of which link it. `/devices/303?tab=customize`.
 * Load alone (`--fixtures customize-linked-cameras`).
 */
import customizeArea from './customize'
import { defineFixtures } from './_define'

const base = customizeArea.handlers
const LINKING: readonly number[] = [101, 205]

const camera = (id: number, name: string, location: string) => ({
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

const MORE = Array.from({ length: 10 }, (_, i) =>
  camera(201 + i, `Camera ${String(i + 1)}`, i % 2 === 0 ? 'Back of house' : 'Garage'),
)

const listed = base['deviceManager.listAll']
const all: readonly { readonly id: number }[] = Array.isArray(listed) ? listed : []
// The base fleet lists id 101 twice (a camera and its block); the last entry wins.
const devices = all.filter((d, i) => all.findLastIndex((x) => x.id === d.id) === i)
const slotsOf = base['deviceExtension.listSlots']

const linksPorch = (id: number): boolean => LINKING.includes(id)

export default defineFixtures({
  area: 'customize-linked-cameras',
  description: 'Customize tab of a device that twelve cameras could link, two of which do',
  handlers: {
    ...base,
    'deviceManager.listAll': [...devices, ...MORE],
    'deviceManager.getLinkedDevicesBatch': (i: { deviceIds: readonly number[] }) =>
      i.deviceIds.map((deviceId) => ({
        deviceId,
        mode: 'manual',
        devices: linksPorch(deviceId)
          ? [{ deviceId: 303, name: 'Porch light', location: 'Front of house', features: [] }]
          : [],
      })),
    'deviceExtension.listSlots': (i: { deviceId: number }) =>
      linksPorch(i.deviceId)
        ? [
            {
              state: 'ok',
              slotRef: 'device-manager:linked-devices',
              slot: 'linked-devices',
              authority: 'device-manager:_linkedDeviceIds',
              activation: null,
              value: { slot: 'linked-devices', deviceIds: [303] },
              sources: [{ deviceId: 303, name: 'Porch light', health: 'ok' }],
            },
          ]
        : typeof slotsOf === 'function'
          ? Reflect.apply(slotsOf, undefined, [i])
          : [],
  },
})
