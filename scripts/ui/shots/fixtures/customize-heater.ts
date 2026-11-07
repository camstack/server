/**
 * Customize tab of a BUILT heater on a plug. `/devices/910?tab=customize` is the composed
 * heater (block `blk-heater`: its own switch, no running rule stored, so the running row
 * follows the switch); `/devices/910` is its device page (the heater row with the quick
 * run read from timed-run status). Load alone (`--fixtures customize-heater`).
 */
import fountainArea from './build-fountain'
import { defineFixtures } from './_define'

const HA = 'provider-homeassistant'
const base = fountainArea.handlers

const FOUNTAIN_DEVICE = {
  id: 910,
  stableId: 'composed-blk-heater',
  addonId: 'composer',
  type: 'heater',
  name: 'Stove',
  location: 'Living room',
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

const PLUG = {
  id: 410,
  stableId: 'plug-410',
  addonId: HA,
  type: 'switch',
  name: 'Desk plug',
  location: 'Office',
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

const PLUG_SOURCE = { addonId: HA, stableId: 'plug-303' }
const BLOCK = {
  id: 'blk-heater',
  name: 'Stove',
  enabled: true,
  source: {
    kind: 'composition',
    composition: {
      target: { kind: 'new', type: 'heater' },
      features: [
        {
          kind: 'fields',
          cap: 'switch',
          fields: {
            on: { kind: 'from', source: PLUG_SOURCE, cap: 'switch', fieldPath: 'on' },
            lastChangedAt: {
              kind: 'from',
              source: PLUG_SOURCE,
              cap: 'switch',
              fieldPath: 'lastChangedAt',
            },
          },
          commands: {
            setState: { kind: 'forward', source: PLUG_SOURCE, cap: 'switch', method: 'setState' },
          },
        },
      ],
    },
  },
}
const VIEW = {
  block: BLOCK,
  state: { kind: 'answered', state: { blockId: 'blk-heater', deviceId: 910 } },
}

const get = (name: string): ((i: unknown) => unknown) => {
  const h = base[name]
  return typeof h === 'function' ? (i: unknown) => Reflect.apply(h, undefined, [i]) : () => h
}

const baseListed = base['deviceManager.listAll']
const baseDevices: readonly unknown[] = Array.isArray(baseListed) ? baseListed : []

export default defineFixtures({
  area: 'customize-heater',
  description: 'Customize tab and device page of a built heater on a plug',
  handlers: {
    ...base,
    'deviceManager.listAll': [...baseDevices, FOUNTAIN_DEVICE, PLUG],
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      i.deviceId === 910
        ? FOUNTAIN_DEVICE
        : i.deviceId === 410
          ? PLUG
          : get('deviceManager.getDevice')(i),
    'deviceManager.getDeviceAggregate': (i: { deviceId: number }) => ({
      settings: { tabs: [], sections: [] },
      live: { sections: [] },
      tabs: undefined,
      deviceId: i.deviceId,
    }),
    'deviceManager.listLocations': [],
    'powerSource.getStatus': { linked: false },
    'preferences.get': {},
    'auth.listLoginMethods': [],
    'deviceManager.getChildren': [],
    'alerts.list': [],
    'deviceManager.listPersistedByAddon': (input: { addonId?: string }) =>
      input.addonId === 'composer' ? [FOUNTAIN_DEVICE] : [],
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.listCompositions': { state: 'loaded', views: [VIEW] },
    'coreBlocks.getComposition': (input: { blockId?: string }) =>
      input.blockId === 'blk-heater'
        ? { state: 'loaded', view: VIEW }
        : { state: 'loaded', view: null },
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': {
      caps: [{ cap: 'consumables' }, { cap: 'power-source' }, { cap: 'running-state' }],
    },
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      i.deviceId === 910 ? { entries: [] } : get('deviceManager.getBindings')(i),
    'deviceManager.listDeviceIdsByCaps': (i: { capNames?: readonly string[] }) => {
      const cap = i.capNames?.[0] ?? ''
      if (cap === 'battery' || cap === 'numeric-sensor' || cap === 'temperature-sensor')
        return [305]
      return get('deviceManager.listDeviceIdsByCaps')(i)
    },
    'deviceManager.getWireableFields': (i: { deviceId: number }) => {
      if (i.deviceId === 301 || i.deviceId === 302) {
        return { caps: [{ cap: 'enum-sensor', fields: [{ path: 'value', kind: 'string' }] }] }
      }
      if (i.deviceId === 303 || i.deviceId === 304) {
        return { caps: [{ cap: 'switch', fields: [{ path: 'on', kind: 'boolean' }] }] }
      }
      if (i.deviceId === 305 || i.deviceId === 306) {
        return {
          caps: [
            { cap: 'control', fields: [{ path: 'value', kind: 'number' }] },
            { cap: 'battery', fields: [{ path: 'level', kind: 'number' }] },
            { cap: 'temperature-sensor', fields: [{ path: 'temperature', kind: 'number' }] },
          ],
        }
      }
      if (i.deviceId === 312) {
        return { caps: [{ cap: 'enum-sensor', fields: [{ path: 'value', kind: 'string' }] }] }
      }
      return { caps: [] }
    },
    'deviceState.getSnapshot': (i: { deviceId: number }) =>
      i.deviceId === 910
        ? {
            switch: { on: true, lastChangedAt: 1_700_000_000_000 },
            'timed-run': { activeUntil: null, quickRun: { duration: 45, unit: 'min' } },
          }
        : i.deviceId === 305
          ? {
              control: { value: 12, unit: 'h' },
              battery: { level: 64 },
              'temperature-sensor': { temperature: 21.5, unit: '°C' },
            }
          : i.deviceId === 301
            ? { 'enum-sensor': { value: '0' } }
            : {},
    'deviceState.getCapSlice': (i: { deviceId: number; capName: string }) =>
      i.deviceId === 910 && i.capName === 'timed-run'
        ? { activeUntil: null, quickRun: { duration: 45, unit: 'min' } }
        : i.deviceId === 910 && i.capName === 'switch'
          ? { on: true, lastChangedAt: 1_700_000_000_000 }
          : { percentage: 73, running: false },
  },
})
