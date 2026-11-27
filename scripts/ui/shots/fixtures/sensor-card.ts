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
 * empty "—" with its unit, D393); 1514 an offline temperature sensor whose stale
 * value is not drawn as current; 1515 and 1516 are numeric readings of no fixed type
 * (CPU load, a grid frequency) whose unit comes from the stored quantity. Load alone
 * (`--fixtures sensor-card`). 1540 is an ambient monitor with seven readings (the
 * grid), 1541 one with three (the pie). Every hero model and row is built with the shared
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
  1515: {
    name: 'CPU load',
    type: 'sensor',
    role: 'numeric-sensor',
    quantity: 'percentage',
    slices: { 'numeric-sensor': { value: 23, lastFetchedAt: NOW - MINUTE } },
  },
  1516: {
    name: 'Frequency',
    type: 'sensor',
    role: 'numeric-sensor',
    quantity: 'frequency',
    slices: { 'numeric-sensor': { value: 49.9, lastFetchedAt: NOW - MINUTE } },
  },
  1520: {
    name: 'Hallway motion',
    type: 'sensor',
    role: 'motion-sensor',
    // Two readings on one device (the pie): motion first (the role), then the light.
    slices: {
      motion: { detected: true, lastDetectedAt: NOW - 3 * MINUTE, autoClearAfterMs: null },
      'ambient-light-sensor': { illuminance: 142, lastFetchedAt: NOW - 2 * MINUTE },
    },
  },
  1521: {
    name: 'Nursery climate',
    type: 'sensor',
    role: 'temperature-sensor',
    slices: {
      'temperature-sensor': { temperature: 21.5, lastFetchedAt: NOW - 2 * MINUTE },
      'humidity-sensor': { humidity: 48, lastFetchedAt: NOW - 2 * MINUTE },
      'ambient-light-sensor': { lastFetchedAt: NOW - 2 * MINUTE },
    },
    caps: ['temperature-sensor', 'humidity-sensor', 'ambient-light-sensor'],
  },
  1522: {
    name: 'Workshop multisensor',
    type: 'sensor',
    role: 'motion-sensor',
    slices: {
      motion: { detected: false, lastDetectedAt: NOW - 40 * MINUTE, autoClearAfterMs: null },
      'temperature-sensor': { temperature: 18.2, lastFetchedAt: NOW - 2 * MINUTE },
      'humidity-sensor': { humidity: 61, lastFetchedAt: NOW - 2 * MINUTE },
      'ambient-light-sensor': { illuminance: 320, lastFetchedAt: NOW - 2 * MINUTE },
      'power-meter': { power: 85, lastFetchedAt: NOW - 2 * MINUTE },
      contact: { entryOpen: false, lastChangedAt: NOW - 90 * MINUTE },
      'enum-sensor': { value: 'Eco', lastFetchedAt: NOW - 2 * MINUTE },
    },
  },
  1540: {
    name: 'Office air monitor',
    type: 'sensor',
    role: 'ambient-monitor',
    slices: {
      'temperature-sensor': { temperature: 22.4, lastFetchedAt: NOW - MINUTE },
      'humidity-sensor': { humidity: 47, lastFetchedAt: NOW - MINUTE },
      'air-quality-sensor': {
        co2: 812,
        voc: 140,
        pm25: 9,
        pm10: 14,
        aqi: 38,
        lastFetchedAt: NOW - MINUTE,
      },
    },
  },
  1541: {
    name: 'Cellar air monitor',
    type: 'sensor',
    role: 'ambient-monitor',
    slices: {
      'temperature-sensor': { temperature: 14.1, lastFetchedAt: NOW - MINUTE },
      'air-quality-sensor': { co2: 640, pm25: 4, lastFetchedAt: NOW - MINUTE },
    },
  },
  1530: {
    name: 'Garden bridge',
    type: 'container',
    role: '',
    slices: {},
  },
  1531: {
    name: 'Garden gate contact',
    type: 'sensor',
    role: 'contact-sensor',
    parentDeviceId: 1530,
    slices: { contact: { entryOpen: false, lastChangedAt: NOW - 20 * MINUTE } },
  },
  1532: {
    name: 'Garden shed temperature',
    type: 'sensor',
    role: 'temperature-sensor',
    parentDeviceId: 1530,
    offline: true,
    slices: { 'temperature-sensor': { temperature: 9, lastFetchedAt: NOW - 5 * 60 * MINUTE } },
  },
  1533: {
    name: 'Garden path motion',
    type: 'sensor',
    role: 'motion-sensor',
    parentDeviceId: 1530,
    slices: { motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null } },
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
    ...(spec.quantity === undefined
      ? {}
      : { sourceInfo: { id: `sensor.card_${id}`, system: 'enpal', quantity: spec.quantity } }),
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
/** The ambient monitors keep their own series; every other device here borrows the dishwasher's. */
const OWN_HISTORY: ReadonlySet<number> = new Set([1540, 1541])
const viaHistory = (path: string): ((i: unknown) => unknown) => {
  const h = history[path]
  return typeof h === 'function'
    ? (i: unknown) => {
        const own = (i as { deviceId?: number }).deviceId
        const deviceId = own !== undefined && OWN_HISTORY.has(own) ? own : 202
        return Reflect.apply(h, undefined, [{ ...(i as object), deviceId }])
      }
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
    'deviceRuns.listRuns': () => ({ __error: 'no provider' }),
  },
})
