/**
 * Group helpers (D944 phase 1a). `/build/compositions/new` is the template
 * picker. `/devices/910` is a temperature group: one member reporting,
 * Garden left out.
 */
import { compileHelper } from '../../../../packages/types/src/composition/helpers/compile.ts'
import { defineFixtures } from './_define'

const porch = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.porch' },
  cap: 'temperature-sensor',
  fieldPath: 'celsius',
}
const garden = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.garden' },
  cap: 'temperature-sensor',
  fieldPath: 'celsius',
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

const HELPER = device(910, 'Veranda', 'composed-blk-veranda', 'composer', true)
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

const BLOCK = {
  id: 'blk-veranda',
  name: 'Veranda',
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
  return ['temperature-sensor', 'group-status', 'device-status']
}

export default defineFixtures({
  area: 'helpers',
  description: 'Group helper template picker, member selector, and device status',
  handlers: {
    'deviceManager.listAll': [HELPER, PORCH, GARDEN, LIGHTS, LAMP, DESK],
    'deviceManager.getDevice': (input: { deviceId?: number }) => {
      if (input.deviceId === 910) return HELPER
      if (input.deviceId === 911) return PORCH
      if (input.deviceId === 912) return GARDEN
      if (input.deviceId === 920) return LIGHTS
      if (input.deviceId === 921) return LAMP
      if (input.deviceId === 922) return DESK
      return null
    },
    'deviceManager.getDeviceAggregate': (input: { deviceId?: number }) =>
      input.deviceId === 920
        ? { settings: { tabs: [], sections: [] }, live: { sections: [] }, deviceId: 920 }
        : AGGREGATE,
    'deviceManager.listDeviceIdsByCaps': (input: { capNames?: readonly string[] }) => {
      if (input.capNames?.[0] === 'temperature-sensor') return [911, 912]
      if (input.capNames?.[0] === 'switch') return [921, 922]
      return []
    },
    'deviceManager.getWireableFields': (input: { deviceId?: number }) => {
      if (input.deviceId === 911 || input.deviceId === 912) {
        return {
          caps: [{ cap: 'temperature-sensor', fields: [{ path: 'celsius', kind: 'number' }] }],
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
          'temperature-sensor': { celsius: 21.4 },
          'group-status': { included: 1, excluded: 1, total: 2 },
        }
      }
      if (input.deviceId === 911) return { 'temperature-sensor': { celsius: 21.4 } }
      if (input.deviceId === 920) {
        return {
          switch: { on: true, lastChangedAt: 1 },
          brightness: { percentage: 80, lastChangedAt: 1 },
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
      return {}
    },
    'deviceState.getCapSlice': (input: { deviceId?: number; capName?: string }) => {
      if (input.deviceId === 910 && input.capName === 'temperature-sensor') return { celsius: 21.4 }
      if (input.deviceId === 910 && input.capName === 'group-status') {
        return { included: 1, excluded: 1, total: 2 }
      }
      if (input.deviceId === 911 && input.capName === 'temperature-sensor') return { celsius: 21.4 }
      if (input.deviceId === 920 && input.capName === 'switch')
        return { on: true, lastChangedAt: 1 }
      if (input.deviceId === 920 && input.capName === 'brightness') {
        return { percentage: 80, lastChangedAt: 1 }
      }
      return {}
    },
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
      ],
    },
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': { caps: [{ cap: 'temperature-sensor' }] },
    'deviceManager.listSiteZones': [],
    'deviceExtension.listSlots': [],
    'addonSettings.getDeviceSettings': { sections: [] },
  },
})
