/**
 * A camera's Accessories panel with a floodlight (motion toggle, brightness slider, timed run)
 * and a siren (motion toggle, timed run): the rows where the slider used to squeeze the Run
 * button. Children of the camera fixture's `/devices/101`. Load BEFORE `camera`:
 * `--fixtures camera-accessories-timed,camera,hero-model,helpers --route /devices/101`.
 * Invented data.
 */
import camera from './camera'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const ADDON = 'provider-reolink'
const PARENT = 101
const LIGHT_ID = 6101
const SIREN_ID = 6102

const child = (id: number, type: string, role: string, name: string) => ({
  id,
  stableId: `cam101-acc-${role}`,
  addonId: ADDON,
  type,
  name,
  location: null,
  disabled: false,
  parentDeviceId: PARENT,
  role,
  online: true,
  probed: true,
  features: ['motion-trigger'],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const LIGHT = child(LIGHT_ID, 'light', 'floodlight', 'Driveway Floodlight')
const SIREN = child(SIREN_ID, 'siren', 'siren', 'Driveway Siren')
const CHILDREN = [LIGHT, SIREN]

const COMMON = {
  'device-status': { online: true, lastChangedAt: NOW },
  'motion-trigger': { enabled: true, mode: 'on', lastChangedAt: NOW },
}
const SLICES: Readonly<Record<number, Readonly<Record<string, unknown>>>> = {
  [LIGHT_ID]: {
    ...COMMON,
    switch: { on: false, lastChangedAt: NOW },
    brightness: { level: 60, lastChangedAt: NOW },
    'timed-run': {
      activeUntil: null,
      requestedBy: null,
      quickRun: { duration: 15, unit: 'min' },
      lastFetchedAt: NOW,
    },
  },
  [SIREN_ID]: {
    ...COMMON,
    switch: { on: false, lastChangedAt: NOW },
    'timed-run': {
      activeUntil: null,
      requestedBy: null,
      quickRun: { duration: 1, unit: 'min' },
      lastFetchedAt: NOW,
    },
  },
}

const ours = (id: number | undefined): boolean => id === LIGHT_ID || id === SIREN_ID
const sliceOf = (id: number | undefined): Readonly<Record<string, unknown>> => SLICES[id ?? 0] ?? {}
const fallback = (path: string, input: unknown): unknown => {
  const h = camera.handlers[path]
  return typeof h === 'function' ? (h as (x: unknown) => unknown)(input) : h
}

export default defineFixtures({
  area: 'camera-accessories-timed',
  description: 'Camera 101 carries a floodlight (6101) and a siren (6102), both with the timed run',
  handlers: {
    'deviceManager.getChildren': (i: { parentDeviceId?: number }) =>
      i.parentDeviceId === PARENT ? CHILDREN : [],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      CHILDREN.find((c) => c.id === i.deviceId) ?? fallback('deviceManager.getDevice', i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      ours(i.deviceId)
        ? {
            deviceId: i.deviceId ?? LIGHT_ID,
            entries: Object.keys(sliceOf(i.deviceId)).map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: ADDON,
              providerNodeId: 'hub',
              nativeAddonId: ADDON,
            })),
          }
        : fallback('deviceManager.getBindings', i),
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      ours(i.deviceId) ? sliceOf(i.deviceId) : fallback('deviceState.getSnapshot', i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      ours(i.deviceId)
        ? (sliceOf(i.deviceId)[i.capName ?? ''] ?? {})
        : fallback('deviceState.getCapSlice', i),
  },
})
