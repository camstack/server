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

interface ListedBlocks {
  readonly blocks: readonly {
    readonly source: { readonly composition: { readonly features: unknown[] } }
  }[]
}

function isListedBlocks(value: unknown): value is ListedBlocks {
  return (
    typeof value === 'object' && value !== null && 'blocks' in value && Array.isArray(value.blocks)
  )
}

const listed = base['coreBlocks.list']
if (!isListedBlocks(listed)) throw new Error('fixture base has no coreBlocks.list')
const SOURCE_BLOCK = listed.blocks[0]
// The fountain also carries a temperature-sensor cap with nothing bound yet: its field is "to fill".
const BLOCK = {
  ...SOURCE_BLOCK,
  source: {
    ...SOURCE_BLOCK?.source,
    composition: {
      ...SOURCE_BLOCK?.source.composition,
      features: [
        ...(SOURCE_BLOCK?.source.composition.features ?? []),
        { kind: 'fields', cap: 'temperature-sensor', fields: {} },
      ],
    },
  },
}
const VIEW = {
  block: BLOCK,
  state: { kind: 'answered', state: { blockId: 'blk-fountain', deviceId: 900 } },
}

const get = (name: string): ((i: unknown) => unknown) => {
  const h = base[name]
  return typeof h === 'function' ? (i: unknown) => Reflect.apply(h, undefined, [i]) : () => h
}

const baseListed = base['deviceManager.listAll']
const baseDevices: readonly unknown[] = Array.isArray(baseListed) ? baseListed : []

export default defineFixtures({
  area: 'customize-fountain',
  description: 'Customize tab of a built pet fountain and of a provider plug',
  handlers: {
    ...base,
    'deviceManager.listAll': [...baseDevices, FOUNTAIN_DEVICE, PLUG],
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      i.deviceId === 900
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
      input.blockId === 'blk-fountain'
        ? { state: 'loaded', view: VIEW }
        : { state: 'loaded', view: null },
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': {
      caps: [{ cap: 'consumables' }, { cap: 'power-source' }, { cap: 'running-state' }],
    },
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      i.deviceId === 900 ? { entries: [] } : get('deviceManager.getBindings')(i),
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
      i.deviceId === 900
        ? {
            'pet-fountain': { waterLevel: 0, empty: true, pumpRunning: true },
            consumables: { items: [{ key: 'filter', status: 'ok', remaining: 20 }] },
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
      i.deviceId === 900 && i.capName === 'pet-fountain'
        ? { waterLevel: 0, empty: true, pumpRunning: true, lastFetchedAt: 1_700_000_000_000 }
        : { percentage: 73, running: false },
  },
})
