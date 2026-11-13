/**
 * The Energy system card (#513). `/devices/971` is a full installation —
 * producing, exporting, the storage charging, the heat pump running, today's
 * totals; `/devices/972` one with no storage and no heat pump, whose parts the
 * card leaves out rather than drawing zeros (D393). The storage is the model's
 * `storage` part; the device binds no `battery`. Load BEFORE `helpers`
 * (`--fixtures energy-system,helpers`).
 */
import helpersArea from './helpers'
import { defineFixtures } from './_define'

const ADDON = 'provider-enpal'

const device = (id: number, name: string, stableId: string) => ({
  id,
  stableId,
  addonId: ADDON,
  type: 'energy-system',
  name,
  location: null,
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
})

const FULL = {
  solar: { powerW: 4200, energyKwh: 12000, todayKwh: 18.4 },
  grid: {
    powerW: -1500,
    importKwh: 3000,
    exportKwh: 5000,
    importTodayKwh: 2.1,
    exportTodayKwh: 7.3,
  },
  house: { powerW: 900, energyKwh: 8000, todayKwh: 11.2 },
  heatPump: { powerW: 600, energyKwh: 1500, todayKwh: null },
  storage: {
    stateOfChargePct: 74,
    storedKwh: 7.4,
    capacityKwh: 10,
    powerW: 1200,
    chargedKwh: 2500,
    dischargedKwh: 2300,
    chargedTodayKwh: 6.1,
    dischargedTodayKwh: 4.2,
    healthPct: 96,
  },
  lastFetchedAt: 1,
}

const SLICES: Readonly<Record<number, Record<string, unknown>>> = {
  971: FULL,
  972: {
    ...FULL,
    solar: { powerW: 0, energyKwh: 9000, todayKwh: 6.2 },
    grid: {
      powerW: 650,
      importKwh: 4100,
      exportKwh: 2000,
      importTodayKwh: 4.4,
      exportTodayKwh: 0.8,
    },
    heatPump: null,
    storage: null,
  },
}

const DEVICES = [
  device(971, 'Energy system', 'enpal-system-energy-system'),
  device(972, 'Cottage energy', 'enpal-cottage-energy-system'),
]

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const isOurs = (id: number | undefined): boolean => id !== undefined && id in SLICES

export default defineFixtures({
  area: 'energy-system',
  description:
    'Energy system card (#513): a full Enpal installation, and one without storage or heat pump',
  handlers: {
    'deviceManager.listAll': (i: { addonId?: string }) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      ...DEVICES.filter((d) => i.addonId === undefined || d.addonId === i.addonId),
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      DEVICES.find((d) => d.id === i.deviceId) ?? base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      isOurs(i.deviceId)
        ? {
            deviceId: i.deviceId ?? 0,
            entries: ['energy-system', 'device-status'].map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: ADDON,
              providerNodeId: 'hub',
              nativeAddonId: ADDON,
            })),
          }
        : base('deviceManager.getBindings')(i),
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'deviceManager.getChildren': [],
    'powerSource.getStatus': {
      linked: false,
      switchDeviceId: null,
      switchName: null,
      switchOn: null,
      switchOnline: null,
      restartInProgress: false,
      offSeconds: 0,
    },
    'preferences.get': { rows: [] },
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      isOurs(i.deviceId)
        ? { 'energy-system': SLICES[i.deviceId ?? 0] }
        : base('deviceState.getSnapshot')(i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      isOurs(i.deviceId) && i.capName === 'energy-system'
        ? SLICES[i.deviceId ?? 0]
        : isOurs(i.deviceId)
          ? {}
          : base('deviceState.getCapSlice')(i),
  },
})
