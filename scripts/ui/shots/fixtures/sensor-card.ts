/**
 * The simple sensor card and the model-drawn rows of sensor and control devices.
 * `/devices` lists them; `/devices/1501` is a hot water temperature (48 °C, hot),
 * `/devices/1502` a cold outside temperature, `/devices/1503` a power reading
 * (1221 W), `/devices/1504` an open window contact, `/devices/1505` a text state
 * ("Eco"), `/devices/1506` a humidity reading; 1507-1509 are control devices
 * (a number without bounds, a choice, a text); 1510 is a temperature sensor
 * with no reading yet; 1511 is a container drawn as its child 1512, a
 * temperature sensor with no reading (the registry sensor hero); 1513 a
 * temperature sensor that has never reported, with no slice at all (an
 * empty "—" with its unit, D393). Load alone
 * (`--fixtures sensor-card`). Every hero model and row is built with the shared
 * pure builder, so the fixture draws exactly what the hub would serve.
 */
import { buildHeroModel } from '../../../../packages/types/src/device/hero/build-hero-model.ts'
import { projectDeviceRow } from '../../../../packages/types/src/device/hero/hero-row.ts'
import type { HeroModel } from '../../../../packages/types/src/device/hero/hero-model.ts'
import { defineFixtures } from './_define'
import historyArea from './history'
import { MINUTE, NOW } from './_time'

const ADDON = 'provider-homeassistant'

interface Spec {
  readonly name: string
  readonly type: 'sensor' | 'control' | 'container'
  readonly parentDeviceId?: number
  readonly role: string
  readonly quantity?: string
  /** The operator's display override (`DeviceInfo.display`). */
  readonly display?: Readonly<Record<string, unknown>>
  readonly slices: Readonly<Record<string, unknown>>
  /** Bound caps when they differ from the slice keys (a cap that has not reported). */
  readonly caps?: readonly string[]
  /** The device is offline: its last reading is no longer current. */
  readonly offline?: boolean
}

const SPECS: Readonly<Record<number, Spec>> = {
  1501: {
    name: 'Hot water temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    slices: { 'temperature-sensor': { temperature: 48, lastFetchedAt: NOW - 2 * MINUTE } },
  },
  1502: {
    name: 'Outside temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    slices: { 'temperature-sensor': { temperature: 6.9, lastFetchedAt: NOW - 2 * MINUTE } },
  },
  1503: {
    name: 'Generator minimum power',
    type: 'sensor',
    role: 'power-sensor',
    display: { unit: 'kW' },
    slices: { 'power-meter': { power: 1221, lastFetchedAt: NOW } },
  },
  1504: {
    name: 'Kitchen window',
    type: 'sensor',
    role: 'contact-sensor',
    slices: { contact: { entryOpen: true, lastChangedAt: NOW - 12 * MINUTE } },
  },
  1505: {
    name: 'Hot water mode',
    type: 'sensor',
    role: 'enum-sensor',
    slices: { 'enum-sensor': { value: 'Eco', lastFetchedAt: NOW - 11 * 60 * MINUTE } },
  },
  1506: {
    name: 'Bathroom humidity',
    type: 'sensor',
    role: 'humidity-sensor',
    slices: { 'humidity-sensor': { humidity: 58, lastFetchedAt: NOW - 5 * MINUTE } },
  },
  1507: {
    name: 'Heating curve offset',
    type: 'control',
    role: 'numeric-control',
    slices: {
      control: { kind: 'numeric', value: 2.5, options: [], lastChangedAt: NOW - 30 * MINUTE },
    },
  },
  1508: {
    name: 'Hot water boost',
    type: 'control',
    role: 'select-control',
    slices: {
      control: {
        kind: 'select',
        value: 'Comfort',
        options: ['Eco', 'Comfort', 'Boost'],
        lastChangedAt: NOW - 30 * MINUTE,
      },
    },
  },
  1509: {
    name: 'Holiday note',
    type: 'control',
    role: 'text-control',
    slices: {
      control: { kind: 'text', value: 'Back on Monday', options: [], lastChangedAt: NOW },
    },
  },
  1510: {
    name: 'Cellar temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    // Adopted, never reported: the slice exists but holds no reading.
    slices: { 'temperature-sensor': { lastFetchedAt: NOW - 2 * MINUTE } },
  },
  1511: {
    name: 'Cellar climate',
    type: 'container',
    role: '',
    slices: {},
  },
  1512: {
    name: 'Cellar climate temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    parentDeviceId: 1511,
    // The container's primary child, never reported (the registry hero).
    slices: { 'temperature-sensor': { lastFetchedAt: NOW - 2 * MINUTE } },
  },
  1513: {
    name: 'Pantry temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    caps: ['temperature-sensor'],
    slices: {},
  },
  1514: {
    name: 'Garage temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    offline: true,
    // Offline: the last value is stale and must not be drawn as current.
    slices: { 'temperature-sensor': { temperature: 17.4, lastFetchedAt: NOW - 3 * 60 * MINUTE } },
  },
}

const IDS = Object.keys(SPECS).map(Number)
const specOf = (id: number | undefined): Spec | undefined =>
  id === undefined ? undefined : SPECS[id]

function deviceOf(id: number, spec: Spec): Record<string, unknown> {
  return {
    id,
    stableId: `sensor.card_${id}`,
    addonId: ADDON,
    type: spec.type,
    name: spec.name,
    location: 'Utility room',
    disabled: false,
    parentDeviceId: spec.parentDeviceId ?? null,
    role: spec.role,
    online: spec.offline !== true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
    ...(spec.display === undefined ? {} : { display: spec.display }),
  }
}

function modelOf(id: number, canActuate: boolean): HeroModel | null {
  const spec = SPECS[id]
  // A container has no model of its own: it draws as its primary child.
  if (spec === undefined || spec.type === 'container') return null
  return buildHeroModel({
    device: {
      id,
      type: spec.type,
      role: spec.role,
      name: spec.name,
      online: spec.offline !== true,
      integration: 'Enpal',
    },
    caps: [...(spec.caps ?? Object.keys(spec.slices)), 'device-status'],
    features: [],
    slices: spec.slices,
    now: NOW,
    remoteCommands: null,
    access: { canActuate },
  })
}

const history = historyArea.handlers
const viaHistory = (path: string): ((i: unknown) => unknown) => {
  const h = history[path]
  return typeof h === 'function'
    ? (i: unknown) => Reflect.apply(h, undefined, [{ ...(i as object), deviceId: 202 }])
    : () => h ?? null
}

export default defineFixtures({
  area: 'sensor-card',
  description: 'Simple sensor cards (temperature, power, contact, text) and sensor/control rows',
  handlers: {
    'deviceManager.listAll': IDS.map((id) => deviceOf(id, SPECS[id] as Spec)),
    'deviceManager.getDevice': (i: { deviceId?: number }) => {
      const spec = specOf(i.deviceId)
      return spec === undefined ? null : deviceOf(i.deviceId ?? 0, spec)
    },
    'deviceManager.getBindings': (i: { deviceId?: number }) => {
      const spec = specOf(i.deviceId)
      return {
        deviceId: i.deviceId ?? 0,
        entries: (spec?.caps ?? Object.keys(spec?.slices ?? {})).map((capName) => ({
          capName,
          kind: 'native' as const,
          providerAddonId: ADDON,
          providerNodeId: 'hub',
          nativeAddonId: ADDON,
        })),
      }
    },
    'deviceManager.getChildren': (i: { parentDeviceId?: number }) =>
      IDS.filter((id) => SPECS[id]?.parentDeviceId === i.parentDeviceId).map((id) =>
        deviceOf(id, SPECS[id] as Spec),
      ),
    'deviceManager.listLocations': [],
    'deviceManager.getRoleDisplayDefaults': { defaults: {} },
    'deviceManager.getDeviceAggregate': (i: { deviceId?: number }) => ({
      settings: { tabs: [], sections: [] },
      live: { sections: [] },
      tabs: undefined,
      deviceId: i.deviceId ?? 0,
    }),
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'powerSource.getStatus': { linked: false },
    'preferences.get': { rows: [] },
    'alerts.list': [],
    'deviceState.getSnapshot': (i: { deviceId?: number }) => specOf(i.deviceId)?.slices ?? {},
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      specOf(i.deviceId)?.slices[i.capName ?? ''] ?? {},
    'heroLayout.getHeroModel': (i: { deviceId?: number; canActuate?: boolean }) =>
      modelOf(i.deviceId ?? 0, i.canActuate !== false),
    'heroLayout.getRowModels': (i: { deviceIds?: readonly number[]; canActuate?: boolean }) =>
      (i.deviceIds ?? []).map((id) => {
        const model = modelOf(id, i.canActuate !== false)
        return model === null ? null : projectDeviceRow(model)
      }),
    'deviceHistory.listSeries': viaHistory('deviceHistory.listSeries'),
    'deviceHistory.query': viaHistory('deviceHistory.query'),
    'deviceHistory.queryMany': history['deviceHistory.queryMany'] ?? null,
    'deviceHistory.getDeviceEnabled': { enabled: true },
  },
})
