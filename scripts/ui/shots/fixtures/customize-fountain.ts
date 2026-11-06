/**
 * Customize tab of a BUILT pet fountain. `/devices/900?tab=customize` is the composed
 * fountain (block `blk-fountain`, entities in the Kitchen); `/devices/410?tab=customize`
 * is a provider device with Customize. Load alone (`--fixtures customize-fountain`).
 */
import fountainArea from './build-fountain'
import { defineFixtures } from './_define'

const HA = 'provider-homeassistant'
const base = fountainArea.handlers

const FOUNTAIN_DEVICE = {
  id: 900,
  stableId: 'composed-blk-fountain',
  addonId: 'composer',
  type: 'pet-fountain',
  name: 'Kitchen fountain',
  location: 'Kitchen',
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

const get = (name: string): ((i: never) => unknown) => {
  const h = base[name]
  return typeof h === 'function' ? (h as (i: never) => unknown) : () => h
}

export default defineFixtures({
  area: 'customize-fountain',
  description: 'Customize tab of a built pet fountain and of a provider plug',
  handlers: {
    ...base,
    'deviceManager.listAll': [
      ...(base['deviceManager.listAll'] as unknown[]),
      FOUNTAIN_DEVICE,
      PLUG,
    ],
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      i.deviceId === 900
        ? FOUNTAIN_DEVICE
        : i.deviceId === 410
          ? PLUG
          : (get('deviceManager.getDevice') as (x: unknown) => unknown)(i),
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
    'coreBlocks.getComposition': (input: { blockId?: string }) =>
      (get('coreBlocks.getComposition') as (x: unknown) => unknown)(input),
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': {
      caps: [{ cap: 'consumables' }, { cap: 'power-source' }, { cap: 'running-state' }],
    },
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      i.deviceId === 900
        ? { entries: [] }
        : (get('deviceManager.getBindings') as (x: unknown) => unknown)(i),
    'deviceManager.listDeviceIdsByCaps': (i: { capNames?: readonly string[] }) => {
      const cap = i.capNames?.[0] ?? ''
      if (cap === 'battery' || cap === 'numeric-sensor') return [305]
      return (get('deviceManager.listDeviceIdsByCaps') as (x: unknown) => unknown)(i)
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
          ],
        }
      }
      if (i.deviceId === 312) {
        return { caps: [{ cap: 'enum-sensor', fields: [{ path: 'value', kind: 'string' }] }] }
      }
      return { caps: [] }
    },
    'deviceState.getSnapshot': (i: { deviceId: number }) =>
      i.deviceId === 900
        ? {
            'pet-fountain': { waterLevel: 0, empty: true, pumpRunning: true },
            consumables: { items: [{ key: 'filter', status: 'ok', remaining: 20 }] },
          }
        : i.deviceId === 305
          ? { control: { value: 12 }, battery: { level: 64, unit: '%' } }
          : i.deviceId === 301
            ? { 'enum-sensor': { value: '0' } }
            : {},
    'deviceState.getCapSlice': (i: { deviceId: number; capName: string }) =>
      i.deviceId === 900 && i.capName === 'pet-fountain'
        ? { waterLevel: 0, empty: true, pumpRunning: true, lastFetchedAt: 1_700_000_000_000 }
        : { percentage: 73, running: false },
  },
})
