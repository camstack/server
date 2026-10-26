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

const AGGREGATE = {
  settings: { tabs: [], sections: [] },
  live: { sections: [] },
  tabs: undefined,
  deviceId: 910,
}

export default defineFixtures({
  area: 'helpers',
  description: 'Group helper template picker, member selector, and device status',
  handlers: {
    'deviceManager.listAll': [HELPER, PORCH, GARDEN],
    'deviceManager.getDevice': (input: { deviceId?: number }) => {
      if (input.deviceId === 910) return HELPER
      if (input.deviceId === 911) return PORCH
      if (input.deviceId === 912) return GARDEN
      return null
    },
    'deviceManager.getDeviceAggregate': () => AGGREGATE,
    'deviceManager.listDeviceIdsByCaps': (input: { capNames?: readonly string[] }) =>
      input.capNames?.[0] === 'temperature-sensor' ? [911, 912] : [],
    'deviceManager.getWireableFields': (input: { deviceId?: number }) =>
      input.deviceId === 911 || input.deviceId === 912
        ? { caps: [{ cap: 'temperature-sensor', fields: [{ path: 'celsius', kind: 'number' }] }] }
        : { caps: [] },
    'deviceState.getSnapshot': (input: { deviceId?: number }) => {
      if (input.deviceId === 910) {
        return {
          'temperature-sensor': { celsius: 21.4 },
          'group-status': { included: 1, excluded: 1, total: 2 },
        }
      }
      if (input.deviceId === 911) return { 'temperature-sensor': { celsius: 21.4 } }
      return {}
    },
    'deviceState.getCapSlice': (input: { deviceId?: number; capName?: string }) => {
      if (input.deviceId === 910 && input.capName === 'temperature-sensor') return { celsius: 21.4 }
      if (input.deviceId === 910 && input.capName === 'group-status') {
        return { included: 1, excluded: 1, total: 2 }
      }
      if (input.deviceId === 911 && input.capName === 'temperature-sensor') return { celsius: 21.4 }
      return {}
    },
    'coreBlocks.getComposition': (input: { blockId?: string }) =>
      input.blockId === 'blk-veranda'
        ? {
            state: 'loaded',
            view: {
              block: BLOCK,
              state: { kind: 'answered', state: { blockId: 'blk-veranda', deviceId: 910 } },
            },
          }
        : { state: 'loaded', view: null },
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
