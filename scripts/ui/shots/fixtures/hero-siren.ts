/**
 * A camera's siren accessory: `/devices/591` is a `siren` (role `siren`) child
 * of camera 590, bound to a native `switch` (setState only) plus
 * `device-status` and `feature-probe`, exactly as the hub reports it. Load
 * with `hero-model` BEFORE `helpers` (`--fixtures hero-model,hero-siren,helpers`).
 */
import helpersArea from './helpers'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const ADDON = 'provider-hikvision'
const ID = 591

export const SIREN_DEVICE = {
  id: ID,
  stableId: 'mac-e8a0edb96bcf-acc-siren',
  addonId: ADDON,
  type: 'siren',
  name: 'Videocamera salone Siren',
  location: null,
  disabled: false,
  parentDeviceId: 590,
  role: 'siren',
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
}

const SLICES: Readonly<Record<string, unknown>> = {
  switch: { on: false, lastChangedAt: 0 },
  'device-status': { online: true, lastChangedAt: NOW },
}

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const ours = (id: number | undefined): boolean => id === ID

export default defineFixtures({
  area: 'hero-siren',
  description: 'A camera siren accessory (591): native switch, role siren, off',
  handlers: {
    'deviceManager.listAll': (i: unknown) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      SIREN_DEVICE,
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      ours(i.deviceId) ? SIREN_DEVICE : base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      ours(i.deviceId)
        ? {
            deviceId: ID,
            entries: [...Object.keys(SLICES), 'feature-probe', 'device-ops'].map((capName) => ({
              capName,
              kind: 'native' as const,
              ...(capName === 'switch' ? { implementedMethods: ['setState'] } : {}),
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
