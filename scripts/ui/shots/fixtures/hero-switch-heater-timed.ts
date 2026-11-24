/**
 * A plain relay: `/devices/972` "Patio heater" is a
 * `switch` with no role, on, with the timed-run binding every switch has (D1097). Load
 * with `hero-model` BEFORE `helpers` (`--fixtures hero-model,hero-switch-heater-timed,helpers`).
 */
import { buildHeroModel } from '../../../../packages/types/src/device/hero/build-hero-model.ts'
import helpersArea from './helpers'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const ADDON = 'provider-homeassistant'
const ID = 972

const DEVICE = {
  id: ID,
  stableId: 'switch.patio_heater',
  addonId: ADDON,
  type: 'switch',
  name: 'Patio heater',
  location: 'Porch',
  disabled: false,
  parentDeviceId: null,
  role: 'switch-heater',
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
  'timed-run': {
    activeUntil: null,
    requestedBy: null,
    quickRun: { duration: 15, unit: 'min' },
    lastFetchedAt: NOW,
  },
}

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const ours = (id: number | undefined): boolean => id === ID

export default defineFixtures({
  area: 'hero-switch-heater-timed',
  description:
    'Model-driven hero: the same relay (972) with the timed-run binding every switch has (D1097): the run-for row',
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
    'heroLayout.getHeroModel': (i: { deviceId?: number; canActuate?: boolean }) =>
      ours(i.deviceId)
        ? buildHeroModel({
            device: {
              id: ID,
              type: DEVICE.type,
              role: DEVICE.role,
              name: DEVICE.name,
              online: true,
            },
            caps: Object.keys(SLICES),
            features: [],
            slices: SLICES,
            now: NOW,
            remoteCommands: null,
            access: { canActuate: i.canActuate !== false },
          })
        : null,
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
