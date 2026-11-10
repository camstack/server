/**
 * Two more devices for the model-driven hero: `/devices/981` "Bedroom blind" (a
 * stoppable, positionable cover at 40 %) and `/devices/982` "Lavatrice" (a washer with a
 * power-source plug, consumables and a history). Their models are in `hero-model`; load
 * `hero-model` first and `helpers` last (`--fixtures hero-model,hero-utility,helpers`).
 */
import helpersArea from './helpers'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const ADDON = 'provider-homeassistant'

interface Spec {
  readonly name: string
  readonly type: string
  readonly caps: readonly string[]
  readonly slices: Readonly<Record<string, unknown>>
}

const SPECS: Readonly<Record<number, Spec>> = {
  981: {
    name: 'Bedroom blind',
    type: 'cover',
    caps: ['cover', 'device-status'],
    slices: { cover: { state: 'open', position: 40, tiltPosition: null, lastChangedAt: NOW } },
  },
  982: {
    name: 'Lavatrice',
    type: 'washer',
    caps: ['device-status', 'running-state', 'power-meter', 'power-source', 'consumables'],
    slices: {
      'running-state': {
        running: true,
        since: NOW - 35 * 60_000,
        source: 'native',
        phase: 'Rinse',
        lastFetchedAt: NOW,
      },
      'power-meter': { power: 412, energy: 18.42, lastFetchedAt: NOW },
      'power-source': { switchOn: true, offSeconds: 20, lastFetchedAt: NOW },
    },
  },
}

const deviceOf = (id: number, spec: Spec): Record<string, unknown> => ({
  id,
  stableId: `hero.utility.${String(id)}`,
  addonId: ADDON,
  type: spec.type,
  name: spec.name,
  location: 'Home',
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

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const specOf = (id: number | undefined): Spec | undefined => SPECS[id ?? 0]

export default defineFixtures({
  area: 'hero-utility',
  description:
    'Model-driven hero: a blind (981) and a washer with power source and consumables (982)',
  handlers: {
    'deviceManager.listAll': (i: unknown) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      ...Object.entries(SPECS).map(([id, spec]) => deviceOf(Number(id), spec)),
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) => {
      const spec = specOf(i.deviceId)
      return spec === undefined
        ? base('deviceManager.getDevice')(i)
        : deviceOf(i.deviceId ?? 0, spec)
    },
    'deviceManager.getBindings': (i: { deviceId?: number }) => {
      const spec = specOf(i.deviceId)
      return spec === undefined
        ? base('deviceManager.getBindings')(i)
        : {
            deviceId: i.deviceId,
            entries: spec.caps.map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: ADDON,
              providerNodeId: 'hub',
              nativeAddonId: ADDON,
            })),
          }
    },
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'deviceManager.getChildren': [],
    'preferences.get': { rows: [] },
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      specOf(i.deviceId)?.slices ?? base('deviceState.getSnapshot')(i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) => {
      const spec = specOf(i.deviceId)
      return spec === undefined
        ? base('deviceState.getCapSlice')(i)
        : (spec.slices[i.capName ?? ''] ?? {})
    },
  },
})
