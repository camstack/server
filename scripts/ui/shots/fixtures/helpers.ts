/**
 * Group helpers (D944 phase 1a). `/build/compositions/new` is the template
 * picker, with the Actuators and Math sections. `/devices/910` is a
 * temperature group: one member reporting, Garden left out. `/devices/930`
 * is a lock group of two doors: Lock all, Unlock all (which asks first), and
 * one door that failed the last command.
 */
import { compileHelper } from '../../../../packages/types/src/composition/helpers/compile.ts'
import { defineFixtures } from './_define'

const porch = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.porch' },
  cap: 'temperature-sensor',
  fieldPath: 'temperature',
}
const garden = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.garden' },
  cap: 'temperature-sensor',
  fieldPath: 'temperature',
}

const compiled = compileHelper({
  kind: 'group',
  templateId: 'temperature',
  aggregate: 'mean',
  members: [porch, garden],
})
if (!compiled.ok) throw new Error('helper fixture did not compile')

const lamp = {
  source: { addonId: 'provider-homeassistant', stableId: 'light.lamp' },
  cap: 'switch',
  fieldPath: 'on',
}
const desk = {
  source: { addonId: 'provider-homeassistant', stableId: 'light.desk' },
  cap: 'switch',
  fieldPath: 'on',
}
const lights = compileHelper({
  kind: 'group',
  templateId: 'light',
  aggregate: 'any',
  active: 'at-least-one',
  members: [lamp, desk],
})
if (!lights.ok) throw new Error('light helper fixture did not compile')

const doorA = {
  source: { addonId: 'provider-homeassistant', stableId: 'lock.front' },
  cap: 'lock-control',
  fieldPath: 'state',
}
const doorB = {
  source: { addonId: 'provider-homeassistant', stableId: 'lock.back' },
  cap: 'lock-control',
  fieldPath: 'state',
}
const doors = compileHelper({
  kind: 'group',
  templateId: 'lock',
  aggregate: 'any',
  active: 'at-least-one',
  members: [doorA, doorB],
})
if (!doors.ok) throw new Error('lock helper fixture did not compile')

const device = (id: number, name: string, stableId: string, addonId: string, online: boolean) => ({
  id,
  stableId,
  addonId,
  type: 'sensor',
  name,
  location: 'Porch',
  disabled: false,
  parentDeviceId: null,
  role: 'temperature-sensor',
  online,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const HELPER = device(910, 'Front door', 'composed-blk-veranda', 'composer', true)
const PORCH = device(911, 'Porch', 'sensor.porch', 'provider-homeassistant', true)
const GARDEN = device(912, 'Garden', 'sensor.garden', 'provider-homeassistant', false)
const LIGHTS = {
  ...device(920, 'Porch lights', 'composed-blk-porch-lights', 'composer', true),
  type: 'light',
  role: null,
  features: [],
}
const LAMP = {
  ...device(921, 'Lamp', 'light.lamp', 'provider-homeassistant', true),
  type: 'light',
  role: null,
  features: ['light-color-rgb', 'light-color-mired'],
}
const DESK = {
  ...device(922, 'Desk', 'light.desk', 'provider-homeassistant', false),
  type: 'light',
  role: null,
  features: ['light-color-mired'],
}

const DOORS = {
  ...device(930, 'House doors', 'composed-blk-doors', 'composer', true),
  type: 'lock',
  role: null,
  features: [],
}
const FRONT = {
  ...device(931, 'Front door', 'lock.front', 'provider-homeassistant', true),
  type: 'lock',
  role: null,
  features: [],
}
const BACK = {
  ...device(932, 'Back door', 'lock.back', 'provider-homeassistant', true),
  type: 'lock',
  role: null,
  features: [],
}

const BLOCK = {
  id: 'blk-veranda',
  name: 'Front door',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: 1,
  source: { kind: 'composition', composition: compiled.composition },
}

const LIGHT_BLOCK = {
  id: 'blk-porch-lights',
  name: 'Porch lights',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: 1,
  source: { kind: 'composition', composition: lights.composition },
}

const DOOR_BLOCK = {
  id: 'blk-doors',
  name: 'House doors',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: 1,
  source: { kind: 'composition', composition: doors.composition },
}

const AGGREGATE = {
  settings: { tabs: [], sections: [] },
  live: { sections: [] },
  tabs: undefined,
  deviceId: 910,
}

function bindingCaps(deviceId: number | undefined): readonly string[] {
  if (deviceId === 921) return ['switch', 'brightness', 'color', 'device-status']
  if (deviceId === 922) return ['switch', 'brightness', 'device-status']
  if (deviceId === 920)
    return ['switch', 'brightness', 'group-status', 'group-commands', 'device-status']
  if (deviceId === 930)
    return ['group-active', 'lock-control', 'group-status', 'group-commands', 'device-status']
  if (deviceId === 931 || deviceId === 932) return ['lock-control', 'device-status']
  return ['temperature-sensor', 'group-status', 'device-status']
}

export default defineFixtures({
  area: 'helpers',
  description: 'Group helper template picker, member selector, and device status',
  handlers: {
    'deviceManager.listAll': [HELPER, PORCH, GARDEN, LIGHTS, LAMP, DESK, DOORS, FRONT, BACK],
    'deviceManager.getDevice': (input: { deviceId?: number }) => {
      if (input.deviceId === 910) return HELPER
      if (input.deviceId === 911) return PORCH
      if (input.deviceId === 912) return GARDEN
      if (input.deviceId === 920) return LIGHTS
      if (input.deviceId === 921) return LAMP
      if (input.deviceId === 922) return DESK
      if (input.deviceId === 930) return DOORS
      if (input.deviceId === 931) return FRONT
      if (input.deviceId === 932) return BACK
      return null
    },
    'deviceManager.getDeviceAggregate': (input: { deviceId?: number }) =>
      input.deviceId === 920 || input.deviceId === 930
        ? {
            settings: { tabs: [], sections: [] },
            live: { sections: [] },
            deviceId: input.deviceId,
          }
        : AGGREGATE,
    'deviceManager.listDeviceIdsByCaps': (input: { capNames?: readonly string[] }) => {
      if (input.capNames?.[0] === 'temperature-sensor') return [911, 912]
      if (input.capNames?.[0] === 'switch') return [921, 922]
      if (input.capNames?.[0] === 'lock-control') return [931, 932]
      return []
    },
    'deviceManager.getWireableFields': (input: { deviceId?: number }) => {
      if (input.deviceId === 931 || input.deviceId === 932) {
        return { caps: [{ cap: 'lock-control', fields: [{ path: 'state', kind: 'enum' }] }] }
      }
      if (input.deviceId === 911 || input.deviceId === 912) {
        return {
          caps: [{ cap: 'temperature-sensor', fields: [{ path: 'temperature', kind: 'number' }] }],
        }
      }
      if (input.deviceId === 921 || input.deviceId === 922) {
        return { caps: [{ cap: 'switch', fields: [{ path: 'on', kind: 'boolean' }] }] }
      }
      return { caps: [] }
    },
    'deviceManager.getBindings': (input: { deviceId?: number }) => ({
      deviceId: input.deviceId ?? 0,
      entries: bindingCaps(input.deviceId).map((capName) => ({
        capName,
        kind: 'native' as const,
        providerAddonId: 'composer',
        providerNodeId: 'hub',
        nativeAddonId: 'composer',
      })),
    }),
    'deviceState.getSnapshot': (input: { deviceId?: number }) => {
      if (input.deviceId === 910) {
        return {
          'temperature-sensor': { temperature: 21.4 },
          'group-status': { included: 1, excluded: 1, total: 2 },
        }
      }
      if (input.deviceId === 911) return { 'temperature-sensor': { temperature: 21.4 } }
      if (input.deviceId === 920) {
        return {
          switch: { on: true, lastChangedAt: 1 },
          brightness: { level: 80, lastChangedAt: 1 },
          'group-status': { included: 1, excluded: 1, total: 2 },
          'group-commands': {
            results: [
              { deviceId: 921, cap: 'switch', method: 'setState', ok: true, at: 1 },
              {
                deviceId: 922,
                cap: 'switch',
                method: 'setState',
                ok: false,
                error: 'relay refused',
                at: 1,
              },
            ],
          },
        }
      }
      if (input.deviceId === 921) return { switch: { on: true, lastChangedAt: 1 } }
      if (input.deviceId === 930) {
        return {
          'group-active': { active: true, lastChangedAt: 1 },
          'group-status': { included: 2, excluded: 0, total: 2 },
          'group-commands': {
            results: [
              { deviceId: 931, cap: 'lock-control', method: 'lock', ok: true, at: 1 },
              {
                deviceId: 932,
                cap: 'lock-control',
                method: 'lock',
                ok: false,
                error: 'bolt is jammed',
                at: 1,
              },
            ],
          },
        }
      }
      if (input.deviceId === 931 || input.deviceId === 932) {
        return { 'lock-control': { state: 'locked', lastChangedAt: 1 } }
      }
      return {}
    },
    'deviceState.getCapSlice': (input: { deviceId?: number; capName?: string }) => {
      if (input.deviceId === 910 && input.capName === 'temperature-sensor')
        return { temperature: 21.4 }
      if (input.deviceId === 910 && input.capName === 'group-status') {
        return { included: 1, excluded: 1, total: 2 }
      }
      if (input.deviceId === 911 && input.capName === 'temperature-sensor')
        return { temperature: 21.4 }
      if (input.deviceId === 920 && input.capName === 'switch')
        return { on: true, lastChangedAt: 1 }
      if (input.deviceId === 920 && input.capName === 'brightness') {
        return { level: 80, lastChangedAt: 1 }
      }
      return {}
    },
    'actions.list': [],
    'coreBlocks.list': { blocks: [] },
    'coreBlocks.getComposition': (input: { blockId?: string }) => {
      if (input.blockId === 'blk-veranda') {
        return {
          state: 'loaded',
          view: {
            block: BLOCK,
            state: { kind: 'answered', state: { blockId: 'blk-veranda', deviceId: 910 } },
          },
        }
      }
      if (input.blockId === 'blk-doors') {
        return {
          state: 'loaded',
          view: {
            block: DOOR_BLOCK,
            state: { kind: 'answered', state: { blockId: 'blk-doors', deviceId: 930 } },
          },
        }
      }
      if (input.blockId === 'blk-porch-lights') {
        return {
          state: 'loaded',
          view: {
            block: LIGHT_BLOCK,
            state: { kind: 'answered', state: { blockId: 'blk-porch-lights', deviceId: 920 } },
          },
        }
      }
      return { state: 'loaded', view: null }
    },
    'coreBlocks.listCompositions': {
      state: 'loaded',
      views: [
        {
          block: BLOCK,
          state: { kind: 'answered', state: { deviceId: 910 } },
        },
        {
          block: LIGHT_BLOCK,
          state: { kind: 'answered', state: { deviceId: 911 } },
        },
        {
          block: DOOR_BLOCK,
          state: { kind: 'answered', state: { deviceId: 912 } },
        },
      ],
    },
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': { caps: [{ cap: 'temperature-sensor' }] },
    'deviceManager.listSiteZones': [],
    'deviceManager.listPersistedByAddon': [],
    'auth.listLoginMethods': [],
    'deviceExtension.listSlots': [],
    'addonSettings.getDeviceSettings': { sections: [] },
  },
})
