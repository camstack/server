/**
 * A smart plug for the model-driven hero: `/devices/971` "Washer plug" is a
 * `switch` device bound to `switch` + `power-meter`, on and drawing 38 W. Load
 * with `hero-model` BEFORE `helpers` (`--fixtures hero-model,hero-plug,helpers`).
 */
import helpersArea from './helpers'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const ADDON = 'provider-homeassistant'
const ID = 971

const DEVICE = {
  id: ID,
  stableId: 'plug.washer',
  addonId: ADDON,
  type: 'switch',
  name: 'Washer plug',
  location: 'Laundry',
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

const SLICES: Readonly<Record<string, unknown>> = {
  switch: { on: true, lastChangedAt: NOW },
  'power-meter': { power: 38, energy: 2.1, lastFetchedAt: NOW },
  'device-status': { online: true, lastChangedAt: NOW },
}

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const ours = (id: number | undefined): boolean => id === ID

export default defineFixtures({
  area: 'hero-plug',
  description: 'Model-driven hero: a smart plug (971) that is on and draws 38 W',
  handlers: {
    'deviceManager.listAll': (i: unknown) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      DEVICE,
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      ours(i.deviceId) ? DEVICE : base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      ours(i.deviceId)
        ? {
            deviceId: ID,
            entries: Object.keys(SLICES).map((capName) => ({
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
      ours(i.deviceId) ? SLICES : base('deviceState.getSnapshot')(i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      ours(i.deviceId) ? (SLICES[i.capName ?? ''] ?? {}) : base('deviceState.getCapSlice')(i),
  },
})
