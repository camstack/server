/**
 * Customize tab of a device other devices trigger. `/devices/910?tab=customize` is the
 * built heater of `customize-heater` with two linked triggers: a wall button on any
 * event, and one automation holding two events of the SAME remote (one row, two
 * events). `/build?tab=custom-device` shows the trigger count on its row. Load alone
 * (`--fixtures customize-triggers`).
 */
import heaterArea from './customize-heater'
import { defineFixtures } from './_define'

const HM = 'provider-homematic'
const base = heaterArea.handlers

function button(id: number, name: string, location: string) {
  return {
    id,
    stableId: `button-${id}`,
    addonId: HM,
    type: 'button',
    name,
    location,
    disabled: false,
    parentDeviceId: null,
    role: null,
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
  }
}

const WALL = button(420, 'Wall button', 'Living room')
const REMOTE = button(421, 'Six-key remote', 'Living room')

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
    'deviceManager.listAll': [...devices, WALL, REMOTE],
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      i.deviceId === 420 ? WALL : i.deviceId === 421 ? REMOTE : get('deviceManager.getDevice')(i),
    'deviceManager.listDeviceIdsByCaps': (i: { capNames?: readonly string[] }) => {
      const cap = i.capNames?.[0] ?? ''
      if (cap === 'switch') return [910, 911, 410]
      if (cap === 'event-emitter') return [420, 421]
      return get('deviceManager.listDeviceIdsByCaps')(i)
    },
    'coreBlocks.listTemplateInstances': (i: { deviceId?: number }) => ({
      instances: i.deviceId === undefined || i.deviceId === 910 ? INSTANCES : [],
    }),
  },
})
