/**
 * A relay driving an on/off-only light: `/devices/972` "Porch lamp" is a
 * `switch` with role `switch-light` bound to `switch` alone, on. Load
 * with `hero-model` BEFORE `helpers` (`--fixtures hero-model,hero-switch-light,helpers`).
 */
import helpersArea from './helpers'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const ADDON = 'provider-homeassistant'
const ID = 972

const DEVICE = {
  id: ID,
  stableId: 'switch.porch_lamp',
  addonId: ADDON,
  type: 'switch',
  name: 'Porch lamp',
  location: 'Porch',
  disabled: false,
  parentDeviceId: null,
  role: 'switch-light',
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
  'device-status': { online: true, lastChangedAt: NOW },
}

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const ours = (id: number | undefined): boolean => id === ID

export default defineFixtures({
  area: 'hero-switch-light',
  description: 'Model-driven hero: a relay (972) with role switch-light, on, no brightness',
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
