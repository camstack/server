/**
 * Customize tab of a device other devices trigger. `/devices/910?tab=customize` is the
 * built heater of `customize-heater` with linked triggers: a wall button on any
 * event, one automation holding two events of the SAME remote (one row, two
 * events), a motion sensor holding it on for five minutes, and a camera holding it
 * on at night on a person or a vehicle. `/build?tab=custom-device` shows the trigger count on its row. Load alone
 * (`--fixtures customize-triggers`).
 */
import heaterArea from './customize-heater'
import { defineFixtures } from './_define'

const HM = 'provider-homematic'
const base = heaterArea.handlers

function source(id: number, type: string, name: string, location: string) {
  return {
    id,
    stableId: `${type}-${id}`,
    addonId: HM,
    type,
    name,
    location,
    disabled: false,
    parentDeviceId: null,
    role: null,
    online: true,
    probed: true,
    features: [],
    isCamera: type === 'camera',
    config: {},
    secretConfigPaths: [],
    metadata: {},
  }
}

const WALL = source(420, 'button', 'Wall button', 'Living room')
const REMOTE = source(421, 'button', 'Six-key remote', 'Living room')
const MOTION = source(422, 'sensor', 'Hall motion sensor', 'Hall')
const CAMERA = source(423, 'camera', 'Garden camera', 'Garden')
const ADDED = [WALL, REMOTE, MOTION, CAMERA]

const INSTANCES = [
  {
    blockId: 'blk-trigger-wall',
    name: 'Wall button → Stove',
    enabled: true,
    templateId: 'builtin:linked-trigger',
    values: {
      target: 910,
      action: { actionId: 'switch.toggle' },
      when: [{ kind: 'device-fired', deviceId: 420 }],
    },
  },
  {
    blockId: 'blk-trigger-remote',
    name: 'Six-key remote → Stove',
    enabled: false,
    templateId: 'builtin:linked-trigger',
    values: {
      target: 910,
      action: { actionId: 'switch.off' },
      when: [
        { kind: 'device-fired', deviceId: 421, sourceIds: ['3'], eventIds: ['PRESS_SHORT'] },
        { kind: 'device-fired', deviceId: 421, sourceIds: ['3'], eventIds: ['PRESS_LONG'] },
      ],
    },
  },
  {
    blockId: 'blk-trigger-motion',
    name: 'Hall motion sensor → Stove',
    enabled: true,
    templateId: 'builtin:linked-trigger',
    values: {
      target: 910,
      action: { actionId: 'switch.on' },
      when: [
        {
          kind: 'device-becomes',
          deviceId: 422,
          cap: 'motion',
          fieldPath: 'detected',
          becomes: true,
        },
      ],
      onFor: 300,
    },
  },
  {
    blockId: 'blk-trigger-camera',
    name: 'Garden camera → Stove',
    enabled: true,
    templateId: 'builtin:linked-trigger',
    values: {
      target: 910,
      action: { actionId: 'switch.on' },
      when: [
        {
          kind: 'detection',
          deviceIds: [423],
          subjects: [{ macro: 'person' }, { macro: 'vehicle' }],
        },
      ],
      onFor: 5430,
      active: {
        between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 30 } },
      },
    },
  },
]

const get = (name: string): ((i: unknown) => unknown) => {
  const h = base[name]
  return typeof h === 'function' ? (i: unknown) => Reflect.apply(h, undefined, [i]) : () => h
}

const listed = base['deviceManager.listAll']
const devices: readonly unknown[] = Array.isArray(listed) ? listed : []

export default defineFixtures({
  area: 'customize-triggers',
  description: 'Customize tab of a device with linked triggers ("Triggered by")',
  handlers: {
    ...base,
    'deviceManager.listAll': [...devices, ...ADDED],
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      ADDED.find((d) => d.id === i.deviceId) ?? get('deviceManager.getDevice')(i),
    'deviceManager.listDeviceIdsByCaps': (i: { capNames?: readonly string[] }) => {
      const cap = i.capNames?.[0] ?? ''
      if (cap === 'switch') return [910, 911, 410]
      if (cap === 'event-emitter') return [420, 421]
      if (cap === 'motion') return [422]
      return get('deviceManager.listDeviceIdsByCaps')(i)
    },
    'tags.list': [],
    'deviceHistory.listSeries': [],
    'deviceManager.getLinkedDevicesBatch': (i: { deviceIds: readonly number[] }) =>
      i.deviceIds.map((deviceId) => ({ deviceId, mode: 'manual', devices: [] })),
    // The camera in the fleet makes the page ask for its link slots.
    'deviceExtension.listSlots': [],
    'coreBlocks.listTemplateInstances': (i: { deviceId?: number }) => ({
      instances: i.deviceId === undefined || i.deviceId === 910 ? INSTANCES : [],
    }),
  },
})
