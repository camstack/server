/**
 * The fan presets editor on a fan's Customize tab (`/devices/911?tab=customize`).
 * Load BEFORE `customize` (`--fixtures fan-presets,customize`): the first area
 * answering a path wins, and the device reads fall through to the customize
 * area for any other device.
 */
import customizeArea from './customize'
import { defineFixtures } from './_define'

const CONTAINER_ID = 910
const FAN_ID = 911
const LAMP_ID = 912

const device = (id: number, name: string, type: string, parentDeviceId: number | null) => ({
  id,
  stableId: `dev-${id}`,
  addonId: 'provider-homeassistant',
  type,
  name,
  location: 'Bedroom',
  disabled: false,
  parentDeviceId,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const CONTAINER = device(CONTAINER_ID, 'Bedroom fan', 'container', null)
const FAN = device(FAN_ID, 'Bedroom fan', 'fan', CONTAINER_ID)
const LAMP = device(LAMP_ID, 'Bedroom fan light', 'light', CONTAINER_ID)

const delegate = (path: string, input: unknown): unknown => {
  const h = customizeArea.handlers[path]
  return typeof h === 'function' ? (h as (i: unknown) => unknown)(input) : h
}

const fanStep = (method: string, args: Record<string, unknown>) => ({
  kind: 'cap',
  target: { kind: 'devices', ids: [FAN_ID] },
  cap: 'fan-control',
  method,
  args,
})

const NIGHT = {
  id: 'p1',
  name: 'Night',
  steps: [
    fanStep('setPercentage', { speed: 25 }),
    fanStep('setOscillating', { oscillating: false }),
    {
      kind: 'cap',
      target: { kind: 'devices', ids: [LAMP_ID] },
      cap: 'switch',
      method: 'turnOff',
      args: {},
    },
  ],
}
const BOOST = { id: 'p2', name: 'Boost', steps: [fanStep('setPercentage', { speed: 100 })] }

/** The fan's own customization: a power link plus one field the catalog does not know (a temperature). */
const FAN_REF = { addonId: 'provider-homeassistant', stableId: `dev-${FAN_ID}` }
const FAN_CUSTOMIZATION = {
  state: 'loaded',
  view: {
    block: {
      id: 'blk-bedroom-fan',
      name: 'customize:bedroom-fan',
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
          target: { kind: 'existing', device: FAN_REF },
          features: [
            {
              kind: 'fields',
              cap: 'power-meter',
              fields: {
                power: {
                  kind: 'from',
                  source: { addonId: 'provider-homeassistant', stableId: `dev-${LAMP_ID}` },
                  cap: 'power-meter',
                  fieldPath: 'power',
                },
                lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
              },
            },
            {
              kind: 'fields',
              cap: 'temperature-sensor',
              fields: {
                temperature: {
                  kind: 'from',
                  source: {
                    addonId: 'provider-homeassistant',
                    stableId:
                      'ha:ha_001:dev:6cddfefa9609eb6e5778e65913b93b86-sensor.termostato_porch_temperature',
                  },
                  cap: 'temperature-sensor',
                  fieldPath: 'temperature',
                },
              },
            },
          ],
        },
      },
    },
    state: { kind: 'answered', state: null },
  },
}

const isOneOf = (i: { deviceId: number }): boolean =>
  [CONTAINER_ID, FAN_ID, LAMP_ID].includes(i.deviceId)

export default defineFixtures({
  area: 'fan-presets',
  description: 'The fan presets Customize extension on a fan with a light beside it',
  handlers: {
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
    'powerSource.getStatus': {
      linked: false,
      switchDeviceId: null,
      switchName: null,
      switchOn: null,
      switchOnline: null,
      restartInProgress: false,
      offSeconds: 0,
    },
    'deviceManager.listLocations': [],
    'fanPresets.getPresets': [NIGHT, BOOST],
    'mut:fanPresets.setPresets': (i: { presets: unknown[] }) => ({
      status: 'saved',
      count: i.presets.length,
    }),
    'fanPresets.capturePreset': (() => {
      const control = (id: number, value: number): unknown => ({
        kind: 'cap',
        target: { kind: 'devices', ids: [id] },
        cap: 'control',
        method: 'setValue',
        args: { control: { kind: 'numeric', value } },
      })
      const toggle = (id: number, on: boolean): unknown => ({
        kind: 'cap',
        target: { kind: 'devices', ids: [id] },
        cap: 'switch',
        method: 'setState',
        args: { on },
      })
      return {
        steps: [
          control(921, 30),
          control(922, 150),
          control(923, 20),
          control(924, 80),
          toggle(925, true),
          toggle(926, false),
          control(927, 90),
          control(928, 45),
          control(929, 2),
          fanStep('setDirection', { direction: 'forward' }),
          fanStep('setPercentage', { speed: 60 }),
        ],
        items: [
          { group: 'angles', label: 'Angolo oscillazione orizzontale sinistra' },
          { group: 'angles', label: 'Angolo oscillazione orizzontale destra' },
          { group: 'angles', label: 'Angolo oscillazione verticale basso' },
          { group: 'angles', label: 'Angolo oscillazione verticale alto' },
          { group: 'oscillation', label: 'Oscillazione orizzontale' },
          { group: 'oscillation', label: 'Oscillazione verticale' },
          { group: 'angles', label: 'Angolo orizzontale' },
          { group: 'angles', label: 'Angolo verticale' },
          { group: 'angles', label: 'Preset angolo 3D' },
          { group: 'fan', label: 'direction' },
          { group: 'fan', label: 'speed' },
        ],
        omitted: [{ what: 'oscillating', reason: 'oscillating is unknown on this fan' }],
      }
    })(),
    'deviceManager.listDeviceIdsByCaps': [],
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      i.deviceId === FAN_ID
        ? FAN
        : i.deviceId === LAMP_ID
          ? LAMP
          : i.deviceId === CONTAINER_ID
            ? CONTAINER
            : delegate('deviceManager.getDevice', i),
    'coreBlocks.getCustomization': (i: { stableId?: string }) =>
      i.stableId === FAN_REF.stableId
        ? FAN_CUSTOMIZATION
        : delegate('coreBlocks.getCustomization', i),
    'coreBlocks.listComposableCaps': {
      caps: [{ cap: 'power-meter' }, { cap: 'temperature-sensor' }, { cap: 'consumables' }],
    },
    'deviceManager.listAll': [
      CONTAINER,
      FAN,
      LAMP,
      ...((customizeArea.handlers['deviceManager.listAll'] as unknown[]) ?? []),
    ],
    'deviceManager.getBindings': (i: { deviceId: number }) =>
      i.deviceId === FAN_ID
        ? { entries: [{ capName: 'fan-control', nativeAddonId: 'provider-homeassistant' }] }
        : delegate('deviceManager.getBindings', i),
    'deviceManager.getDeviceAggregate': (i: { deviceId: number }) =>
      isOneOf(i)
        ? {
            settings: { tabs: [], sections: [] },
            live: { sections: [] },
            tabs: undefined,
            deviceId: i.deviceId,
          }
        : delegate('deviceManager.getDeviceAggregate', i),
  },
})
