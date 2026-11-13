/**
 * The devices list with a container, its primary child, another part, a
 * standalone energy system and a camera adopted by a hub. Invented.
 * `--fixtures devices-family --route /devices`.
 */
import { defineFixtures } from './_define'

const ENPAL = 'provider-enpal'
const NVR = 'provider-reolink'

const row = (
  id: number,
  name: string,
  type: string,
  addonId: string,
  parentDeviceId: number | null,
  stableId: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  stableId,
  addonId,
  type,
  name,
  location: null,
  disabled: false,
  parentDeviceId,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: type === 'camera',
  config: {},
  secretConfigPaths: [],
  metadata: {},
  ...extra,
})

const CONTAINER = row(5684, 'Enpal system', 'container', ENPAL, null, 'enpal-system', {
  primaryChildPreference: ['energy'],
})
const ENERGY = row(5766, 'Energy system', 'energy-system', ENPAL, 5684, 'enpal-system-energy')
const GRID = row(5767, 'Grid', 'sensor', ENPAL, 5684, 'enpal-system-grid')
const OWN = row(8802, 'Cottage energy', 'energy-system', ENPAL, null, 'cottage-energy')
const HUB = row(8803, 'Home hub', 'hub', NVR, null, 'home-hub')
const PORCH = row(8804, 'Porch', 'camera', NVR, 8803, 'home-hub-porch')

const DEVICES = [CONTAINER, ENERGY, GRID, OWN, HUB, PORCH]

const SLICE = {
  solar: { powerW: 4200, energyKwh: 12000, todayKwh: 18.4 },
  grid: {
    powerW: -1500,
    importKwh: 3000,
    exportKwh: 5000,
    importTodayKwh: 2.1,
    exportTodayKwh: 7.3,
  },
  house: { powerW: 900, energyKwh: 8000, todayKwh: 11.2 },
  heatPump: null,
  storage: {
    stateOfChargePct: 74,
    storedKwh: 7.4,
    capacityKwh: 10,
    powerW: 1200,
    chargedKwh: 2500,
    dischargedKwh: 2300,
    chargedTodayKwh: 6.1,
    dischargedTodayKwh: 4.2,
  },
  lastFetchedAt: 1,
}

const ENERGY_IDS = new Set([5766, 8802])

export default defineFixtures({
  area: 'devices-family',
  description:
    'Devices list: an Enpal container with its primary energy child and a part, plus a hub-adopted camera',
  handlers: {
    'integrations.list': [
      {
        id: 'int_enpal',
        addonId: ENPAL,
        name: 'Enpal',
        enabled: true,
        processState: 'running',
      },
      {
        id: 'int_reolink',
        addonId: NVR,
        name: 'Reolink',
        enabled: true,
        processState: 'running',
      },
    ],
    'deviceManager.listAll': (i: { addonId?: string }) =>
      DEVICES.filter((d) => i.addonId === undefined || d.addonId === i.addonId),
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      DEVICES.find((d) => d.id === i.deviceId) ?? null,
    'deviceManager.getChildren': (i: { deviceId?: number }) =>
      DEVICES.filter((d) => d.parentDeviceId === i.deviceId),
    'deviceManager.getBindings': (i: { deviceId?: number }) => ({
      deviceId: i.deviceId ?? 0,
      entries: ENERGY_IDS.has(i.deviceId ?? 0)
        ? ['energy-system', 'device-status'].map((capName) => ({
            capName,
            kind: 'native' as const,
            providerAddonId: ENPAL,
            providerNodeId: 'hub',
            nativeAddonId: ENPAL,
          }))
        : [],
    }),
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      ENERGY_IDS.has(i.deviceId ?? 0) ? { 'energy-system': SLICE } : {},
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      ENERGY_IDS.has(i.deviceId ?? 0) && i.capName === 'energy-system' ? SLICE : {},
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
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
    'heroLayout.getRowModels': {},
  },
})
