/**
 * Customize tabs. `/devices/101?tab=customize` has no customization.
 * `/devices/101?tab=customize` is a front-door camera with one doorbell block.
 * Load BEFORE `camera` (`--fixtures customize,camera`): the first area answering
 * a path wins.
 */
import { PORCH_COMPOSITION } from '../../../../packages/types/src/composition/cards/__fixtures__/stored-compositions.ts'
import { defineFixtures } from './_define'

const device = (id: number, name: string, location: string, type: string, isCamera = false) => ({
  id,
  stableId: `dev-${id}`,
  addonId: isCamera ? 'provider-reolink' : 'provider-homeassistant',
  type,
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const FLEET = [
  device(101, 'Driveway', 'Front of house', 'camera', true),
  device(102, 'Garden', 'Front of house', 'camera', true),
  device(399, 'Sensore movimento veranda', 'Front of house', 'container'),
  {
    ...device(301, 'Motion', 'Front of house', 'sensor'),
    parentDeviceId: 399,
    role: 'motion-sensor',
  },
  device(307, 'Front door button', 'Front of house', 'switch'),
  device(302, 'Gate contact', 'Front of house', 'sensor'),
  device(303, 'Porch light', 'Front of house', 'light'),
  device(304, 'Garage lamp', 'Garage', 'light'),
  device(305, 'Porch power meter', 'Front of house', 'sensor'),
  device(306, 'Porch plug', 'Front of house', 'switch'),
  {
    id: 101,
    stableId: 'cam-101',
    addonId: 'provider-reolink',
    type: 'camera',
    name: 'Front door',
    location: 'Front of house',
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
  },
  {
    id: 801,
    stableId: 'ha:ha_001:dev:6cddfefa9609eb6e5778e65913b93b86-sensor.termostato_porch_temperature',
    addonId: 'provider-homeassistant',
    type: 'sensor',
    name: 'Porch thermostat',
    location: 'Porch',
    disabled: false,
    parentDeviceId: null,
    role: 'temperature-sensor',
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
  },
  {
    id: 802,
    stableId: 'ha:ha_001:dev:e5f545dc7f0d92d18e8eee5ded55b777-sensor.clima_porch_temperature',
    addonId: 'provider-homeassistant',
    type: 'sensor',
    name: 'Porch climate',
    location: 'Porch',
    disabled: false,
    parentDeviceId: null,
    role: 'temperature-sensor',
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
  },
  {
    id: 803,
    stableId:
      'ha:ha_001:dev:45269aa68c25b3951b36c83fdd1f87ce-binary_sensor.sensore_movimento_porch_motion',
    addonId: 'provider-homeassistant',
    type: 'sensor',
    name: 'Porch motion',
    location: 'Porch',
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
  },
  {
    id: 804,
    stableId: 'mac-040312a373d4',
    addonId: 'provider-hikvision',
    type: 'camera',
    name: 'Porch camera',
    location: 'Porch',
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
  },
]

const candidate = (
  id: number,
  name: string,
  type: string,
  location: string,
  suggested: boolean,
) => ({
  deviceId: id,
  name,
  type,
  location,
  parentName: null,
  suggested,
  reason: suggested ? 'same location' : null,
})

/** Camera 101 (`cam-101`) — one doorbell customization, the shape of a front-door camera. */
const FRONT_DOOR = { addonId: 'provider-reolink', stableId: 'cam-101' }
const FRONT_DOOR_BUTTON = { addonId: 'provider-homeassistant', stableId: 'dev-307' }

const FRONT_DOOR_CUSTOMIZATION = {
  state: 'loaded',
  view: {
    block: {
      id: 'blk-front-door',
      name: 'customize:front-door',
      code: '',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt: 1_700_000_000_000,
      createdBy: 'admin',
      status: 'running',
      lastChangedAt: 1,
      source: {
        kind: 'composition',
        composition: {
          target: { kind: 'existing', device: FRONT_DOOR },
          features: [
            {
              kind: 'fields',
              cap: 'binary',
              fields: {
                on: {
                  kind: 'expression',
                  expr: 'any(d1, within(m1, 300000))',
                  bindings: {
                    d1: {
                      kind: 'from',
                      source: { addonId: 'provider-homeassistant', stableId: 'dev-301' },
                      cap: 'binary',
                      fieldPath: 'on',
                    },
                    m1: {
                      kind: 'from',
                      source: { addonId: 'provider-homeassistant', stableId: 'dev-301' },
                      cap: 'motion',
                      fieldPath: 'lastDetectedAt',
                    },
                  },
                },
                lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
              },
            },
            {
              kind: 'fields',
              cap: 'doorbell',
              enabled: true,
              fields: {
                lastPressedAt: {
                  kind: 'expression',
                  expr: 'latest(rose(active0, changed0, 2000))',
                  bindings: {
                    active0: {
                      kind: 'from',
                      source: FRONT_DOOR_BUTTON,
                      cap: 'switch',
                      fieldPath: 'on',
                    },
                    changed0: {
                      kind: 'from',
                      source: FRONT_DOOR_BUTTON,
                      cap: 'switch',
                      fieldPath: 'lastChangedAt',
                    },
                  },
                },
                pressCountSinceStart: {
                  kind: 'expression',
                  expr: 'count(lastPressedAt)',
                  bindings: {
                    lastPressedAt: {
                      kind: 'from',
                      source: FRONT_DOOR,
                      cap: 'doorbell',
                      fieldPath: 'lastPressedAt',
                    },
                  },
                },
              },
            },
            {
              kind: 'fields',
              cap: 'battery',
              fields: {
                percentage: {
                  kind: 'from',
                  source: {
                    addonId: 'provider-homeassistant',
                    stableId:
                      'ha:ha_001:dev:6cddfefa9609eb6e5778e65913b93b86-sensor.termostato_porch_temperature',
                  },
                  cap: 'numeric-sensor',
                  fieldPath: 'value',
                },
                charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
                sleeping: { kind: 'expression', expr: 'false', bindings: {} },
                lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
              },
            },
          ],
        },
      },
    },
    state: { kind: 'answered', state: null },
  },
}

const PORCH_BLOCK = {
  id: 'blk-porch',
  name: 'Porch (composto)',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: 1,
  source: { kind: 'composition', composition: PORCH_COMPOSITION },
}

export default defineFixtures({
  area: 'customize',
  description: 'Customize tab: linked devices + a same-room fleet that would be suggested',
  handlers: {
    'coreBlocks.getComposition': (input: { blockId?: string }) => {
      if (input.blockId === 'blk-porch') {
        return {
          state: 'loaded',
          view: { block: PORCH_BLOCK, state: { kind: 'answered', state: { deviceId: 4603 } } },
        }
      }
      if (input.blockId === 'blk-new') {
        return {
          state: 'loaded',
          view: {
            block: {
              id: 'blk-new',
              name: 'New sensor',
              code: '',
              enabled: true,
              placement: 'hub',
              createdAt: 1,
              updatedAt: 1,
              createdBy: 'admin',
              status: 'running',
              lastChangedAt: 1,
              source: {
                kind: 'composition',
                composition: {
                  target: { kind: 'new', type: 'sensor', role: 'temperature-sensor' },
                  features: [{ kind: 'fields', cap: 'temperature-sensor', fields: {} }],
                },
              },
            },
            state: { kind: 'answered', state: { deviceId: 4700 } },
          },
        }
      }
      return { state: 'loaded', view: null }
    },
    'coreBlocks.list': { blocks: [] },
    'coreBlocks.listCompositions': {
      state: 'loaded',
      views: [{ block: PORCH_BLOCK, state: { kind: 'answered', state: { deviceId: 4603 } } }],
    },
    'deviceManager.listPersistedByAddon': (input: { addonId?: string }) =>
      input.addonId === 'composer'
        ? [
            {
              id: 4700,
              stableId: 'composed-blk-new',
              addonId: 'composer',
              type: 'sensor',
              name: 'New sensor',
              location: '',
              disabled: false,
              parentDeviceId: null,
              role: 'temperature-sensor',
              online: true,
              probed: true,
              features: [],
              isCamera: false,
              config: {},
              metadata: {},
            },
          ]
        : [],
    'deviceManager.listAll': FLEET,
    'deviceManager.listSiteZones': [],
    'coreBlocks.getCustomization': (input: { stableId?: string }) =>
      input.stableId === FRONT_DOOR.stableId
        ? FRONT_DOOR_CUSTOMIZATION
        : { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': {
      caps: [
        { cap: 'motion' },
        { cap: 'battery' },
        { cap: 'doorbell' },
        { cap: 'running-state' },
        { cap: 'consumables' },
      ],
    },
    'deviceManager.getBindings': (input: { deviceId?: number }) => {
      if (input.deviceId === 101) return { entries: [] }
      if (input.deviceId === 801) {
        return {
          entries: [
            { capName: 'temperature-sensor', nativeAddonId: 'provider-homeassistant' },
            { capName: 'humidity-sensor', nativeAddonId: 'provider-homeassistant' },
          ],
        }
      }
      return { entries: [] }
    },
    'deviceManager.getWireableFields': (i: { deviceId: number }) => {
      if (i.deviceId === 305) {
        return {
          caps: [
            { cap: 'power-meter', fields: [{ path: 'watts', kind: 'number' }] },
            { cap: 'numeric-sensor', fields: [{ path: 'voltage', kind: 'number' }] },
          ],
        }
      }
      if (i.deviceId === 301) {
        return {
          caps: [
            { cap: 'device-status', fields: [{ path: 'online', kind: 'boolean' }] },
            { cap: 'motion', fields: [{ path: 'detected', kind: 'boolean' }] },
            { cap: 'mqtt-broker', fields: [{ path: 'embeddedRunning', kind: 'boolean' }] },
          ],
        }
      }
      if (i.deviceId === 302) {
        return {
          caps: [
            {
              cap: 'binary',
              fields: [
                { path: 'on', kind: 'boolean' },
                { path: 'lastChangedAt', kind: 'number' },
              ],
            },
          ],
        }
      }
      if (i.deviceId === 306) {
        return {
          caps: [
            {
              cap: 'switch',
              fields: [
                { path: 'on', kind: 'boolean' },
                { path: 'lastChangedAt', kind: 'number' },
              ],
            },
          ],
        }
      }
      if (i.deviceId === 801) {
        return {
          caps: [
            { cap: 'battery', fields: [{ path: 'percentage', kind: 'number' }] },
            { cap: 'numeric-sensor', fields: [{ path: 'value', kind: 'number' }] },
          ],
        }
      }
      return { caps: [] }
    },
    'deviceState.getSnapshot': (i: { deviceId: number }) => {
      if (i.deviceId === 305) {
        return {
          'power-meter': { watts: 8.4, unit: 'W' },
          'numeric-sensor': { voltage: 231, unit: 'V' },
        }
      }
      if (i.deviceId === 306) return { switch: { on: true, lastChangedAt: 1_700_000_000_000 } }
      if (i.deviceId === 801) {
        return { battery: { percentage: 82 }, 'numeric-sensor': { value: 82, unit: '%' } }
      }
      if (i.deviceId === 301) {
        return {
          motion: { detected: false },
          'device-status': { online: true },
          'mqtt-broker': { embeddedRunning: true },
        }
      }
      return {}
    },
    'deviceState.getCapSlice': (i: { deviceId: number; capName: string }) => {
      if (i.deviceId === 801 && i.capName === 'temperature-sensor') {
        return { celsius: 21.4, unit: '°C', lastFetchedAt: 1_700_000_000_000 }
      }
      if (i.deviceId === 801 && i.capName === 'humidity-sensor') {
        return { percent: 48, unit: '%', lastFetchedAt: 1_700_000_000_000 }
      }
      if (i.deviceId === 301 && i.capName === 'motion') {
        return { detected: false, lastDetectedAt: 1_700_000_000_000 }
      }
      if (i.deviceId === 101 && i.capName === 'motion') {
        return { detected: true, lastDetectedAt: 1_700_000_000_000 - 12_000 }
      }
      if ((i.deviceId === 101 || i.deviceId === 103) && i.capName === 'doorbell') {
        return { lastPressedAt: 1_700_000_000_000 - 120_000, pressCountSinceStart: 4 }
      }
      return { percentage: 73, running: false }
    },
    'deviceManager.listDeviceIdsByCaps': (i: { capNames: readonly string[] }) => {
      const cap = i.capNames[0]
      if (cap === 'motion') return [301, 302]
      if (cap === 'binary') return [301, 302]
      if (cap === 'switch') return [306]
      if (cap === 'battery' || cap === 'numeric-sensor') return [801]
      if (cap === 'consumables') return [801]
      return []
    },
    'addonSettings.getDeviceSettings': { sections: [] },
    'pipelineOrchestrator.getCameraStatus': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      switchedOff: [],
      cameraSensors:
        i.deviceId === 101
          ? {
              state: 'configured',
              cameraMotion: 'always',
              sensors: [
                {
                  state: 'ready',
                  addonId: 'provider-homeassistant',
                  stableId: 'dev-301',
                  mode: 'confirm',
                  deviceId: 301,
                  name: 'Motion',
                },
              ],
            }
          : { state: 'configured', sensors: [] },
    }),
    'deviceExtension.listSlots': (i: { deviceId: number }) => [
      {
        state: 'ok',
        slotRef: 'device-manager:linked-devices',
        slot: 'linked-devices',
        authority: 'device-manager:_linkedDeviceIds',
        activation: null,
        value: { slot: 'linked-devices', deviceIds: i.deviceId === 101 ? [303] : [] },
        sources: i.deviceId === 101 ? [{ deviceId: 303, name: 'Porch light', health: 'ok' }] : [],
      },
    ],
    'deviceExtension.listCandidates': {
      candidates: [
        candidate(301, 'Porch motion sensor', 'sensor', 'Front of house', true),
        candidate(302, 'Gate contact', 'sensor', 'Front of house', true),
        candidate(303, 'Porch light', 'light', 'Front of house', true),
        candidate(304, 'Garage lamp', 'light', 'Garage', false),
      ],
    },
  },
})
